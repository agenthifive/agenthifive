import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { policies } from "../db/schema/policies";
import { agents } from "../db/schema/agents";
import { connections } from "../db/schema/connections";
import { logPolicyCreated, logPolicyUpdated, logPolicyDeleted } from "../services/audit";
import { PolicyRulesSchema, type PolicyRules, ProviderConstraintsSchema, getDefaultAllowlistsForService, getAllowedModelsForService, SERVICE_CATALOG, type ServiceId, type PolicyTier, isValidActionTemplateId, getActionTemplatesForService } from "@agenthifive/contracts";
import { invalidatePolicyCache, validateRules } from "../services/policy-engine";
import { broadcastPolicyCacheInvalidation } from "../services/pg-listeners";
import { generatePolicyFromTemplate } from "../services/policy-generator";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const policyResponse = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const, format: "uuid" },
    agentId: { type: "string" as const, format: "uuid" },
    connectionId: { type: "string" as const, format: "uuid" },
    connectionLabel: { type: "string" as const, nullable: true },
    connectionProvider: { type: "string" as const, nullable: true },
    status: { type: "string" as const, enum: ["active", "revoked"] },
    allowedModels: { type: "array" as const, items: { type: "string" as const, enum: ["A", "B"] } },
    defaultMode: { type: "string" as const, enum: ["read_only", "read_write", "custom"] },
    stepUpApproval: { type: "string" as const, enum: ["always", "risk_based", "never"] },
    allowlists: { type: "array" as const, items: { type: "object" as const, additionalProperties: true } },
    rateLimits: { type: "object" as const, nullable: true, additionalProperties: true },
    timeWindows: { type: "array" as const, items: { type: "object" as const, additionalProperties: true } },
    rules: { type: "object" as const, additionalProperties: true },
    providerConstraints: { type: "object" as const, nullable: true, additionalProperties: true },
    securityPreset: { type: "string" as const, nullable: true, enum: ["minimal", "standard", "strict"] },
    createdAt: { type: "string" as const, format: "date-time" },
    updatedAt: { type: "string" as const, format: "date-time" },
  },
};

export default async function policyRoutes(fastify: FastifyInstance) {
  /**
   * POST /policies
   * Creates a policy binding: agentId + connectionId.
   */
  fastify.post("/policies", {
    schema: {
      tags: ["Policies"],
      summary: "Create policy",
      description: "Creates a policy binding between an agent and a connection. Controls execution models, access mode, and approval settings.",
      body: {
        type: "object",
        required: ["agentId", "connectionId"],
        properties: {
          agentId: { type: "string", format: "uuid", description: "Agent to bind" },
          connectionId: { type: "string", format: "uuid", description: "Connection to bind" },
          allowedModels: { type: "array", items: { type: "string", enum: ["A", "B"] } },
          defaultMode: { type: "string", enum: ["read_only", "read_write", "custom"], default: "read_only" },
          stepUpApproval: { type: "string", enum: ["always", "risk_based", "never"], default: "risk_based" },
          actionTemplateId: { type: "string", description: "Action template ID — when provided with policyTier, generates policy config from template" },
          policyTier: { type: "string", enum: ["strict", "standard", "minimal"], description: "Policy tier — used with actionTemplateId to generate policy config" },
          securityPreset: { type: "string", enum: ["minimal", "standard", "strict"], description: "Security preset tier selected by the user" },
        },
      },
      response: {
        201: { type: "object", properties: { policy: policyResponse } },
        400: errorResponse,
        404: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid, sub } = request.user;
    const body = request.body as {
      agentId?: string;
      connectionId?: string;
      allowedModels?: string[];
      defaultMode?: string;
      stepUpApproval?: string;
      actionTemplateId?: string;
      policyTier?: PolicyTier;
      securityPreset?: string;
    };
    request.log.info({ action: "create", agentId: body.agentId, connectionId: body.connectionId, actionTemplateId: body.actionTemplateId, policyTier: body.policyTier }, "policy.create.entry");

    if (!body.agentId || !body.connectionId) {
      return reply.code(400).send({ error: "agentId and connectionId are required" });
    }

    // Validate allowedModels format (actual default set after connection lookup)
    if (body.allowedModels) {
      for (const m of body.allowedModels) {
        if (m !== "A" && m !== "B") {
          return reply.code(400).send({ error: "allowedModels must contain only 'A' or 'B'" });
        }
      }
    }

    // Validate defaultMode
    const validModes = ["read_only", "read_write", "custom"] as const;
    const defaultMode = body.defaultMode ?? "read_only";
    if (!validModes.includes(defaultMode as typeof validModes[number])) {
      return reply.code(400).send({ error: "defaultMode must be one of: read_only, read_write, custom" });
    }

    // Validate stepUpApproval
    const validApprovals = ["always", "risk_based", "never"] as const;
    const stepUpApproval = body.stepUpApproval ?? "risk_based";
    if (!validApprovals.includes(stepUpApproval as typeof validApprovals[number])) {
      return reply.code(400).send({ error: "stepUpApproval must be one of: always, risk_based, never" });
    }

    // Verify agent belongs to this workspace
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, body.agentId), eq(agents.workspaceId, wid)))
      .limit(1);

    if (!agent) {
      return reply.code(404).send({ error: "Agent not found in this workspace" });
    }

    // Verify connection belongs to this workspace
    const [connection] = await db
      .select({ id: connections.id, service: connections.service, grantedScopes: connections.grantedScopes })
      .from(connections)
      .where(and(eq(connections.id, body.connectionId), eq(connections.workspaceId, wid)))
      .limit(1);

    if (!connection) {
      return reply.code(404).send({ error: "Connection not found in this workspace" });
    }

    // Default allowedModels from service config (e.g., Telegram/Anthropic → Model B only)
    const serviceAllowedModels = getAllowedModelsForService(connection.service as ServiceId);
    const allowedModels = body.allowedModels ?? serviceAllowedModels;
    for (const m of allowedModels) {
      if (!serviceAllowedModels.includes(m as "A" | "B")) {
        const serviceName = SERVICE_CATALOG[connection.service as ServiceId]?.displayName ?? connection.service;
        request.log.error({ model: m, service: connection.service, allowedModels: serviceAllowedModels }, "policy.create.model_not_supported");
        return reply.code(400).send({
          error: `Model ${m} is not supported for ${serviceName}. Allowed: ${serviceAllowedModels.join(", ")}`,
        });
      }
    }

    // If actionTemplateId + policyTier provided, generate full policy config from template
    // (same logic used in the OAuth callback for permission request approvals)
    let policyValues: typeof policies.$inferInsert;
    if (body.actionTemplateId && body.policyTier) {
      // If given a service ID instead of an action template ID, resolve to the best-matching
      // action template based on the connection's granted scopes (most scopes matched = most specific).
      let resolvedTemplateId = body.actionTemplateId;
      if (!isValidActionTemplateId(resolvedTemplateId)) {
        // Exclude meta-scopes (offline_access is for refresh tokens, not API permissions)
        // that are requested during OAuth but not returned in grantedScopes
        const META_SCOPES = new Set(["offline_access"]);
        const candidates = getActionTemplatesForService(resolvedTemplateId)
          .filter(t => t.scopes.filter(s => !META_SCOPES.has(s)).every(s => (connection.grantedScopes ?? []).includes(s)))
          .sort((a, b) => b.scopes.length - a.scopes.length);
        // For API-key services (Notion, Trello, Jira) all templates have scopes: [],
        // so scope-based sorting can't differentiate read vs manage. Use the connection's
        // grantedScopes to pick the most capable matching template.
        const allEmpty = candidates.length > 1 && candidates.every(t => t.scopes.length === 0);
        if (allEmpty && (connection.grantedScopes ?? []).includes("write")) {
          const manage = candidates.find(t => t.id.endsWith("-manage"));
          if (manage) {
            candidates.sort((a, b) => a === manage ? -1 : b === manage ? 1 : 0);
          }
        }
        if (candidates.length > 0) {
          resolvedTemplateId = candidates[0]!.id;
        } else {
          request.log.error({ actionTemplateId: body.actionTemplateId, grantedScopes: connection.grantedScopes }, "policy.create.unknown_template");
          return reply.code(400).send({ error: `Unknown action template: ${body.actionTemplateId}` });
        }
      }
      try {
        const policyConfig = generatePolicyFromTemplate(resolvedTemplateId, body.policyTier);
        policyValues = {
          agentId: body.agentId,
          connectionId: body.connectionId,
          actionTemplateId: resolvedTemplateId,
          allowedModels,
          defaultMode: defaultMode as "read_only" | "read_write" | "custom",
          stepUpApproval: policyConfig.stepUpApproval,
          allowlists: policyConfig.allowlists,
          rateLimits: policyConfig.rateLimits,
          timeWindows: policyConfig.timeWindows,
          rules: policyConfig.rules,
          securityPreset: body.securityPreset ?? body.policyTier ?? null,
        };
      } catch (err) {
        request.log.error({ err, actionTemplateId: resolvedTemplateId, policyTier: body.policyTier }, "Policy template generation failed");
        // Template generation failed — fall through to default policy
        const defaultAllowlists = getDefaultAllowlistsForService(connection.service);
        policyValues = {
          agentId: body.agentId,
          connectionId: body.connectionId,
          actionTemplateId: resolvedTemplateId,
          allowedModels,
          defaultMode: defaultMode as "read_only" | "read_write" | "custom",
          stepUpApproval: stepUpApproval as "always" | "risk_based" | "never",
          allowlists: defaultAllowlists,
          rateLimits: null,
          timeWindows: [],
          rules: { request: [], response: [] },
          securityPreset: body.securityPreset ?? body.policyTier ?? null,
        };
      }
    } else {
      // No explicit template — try to resolve one from the connection's service.
      // This handles cases where the dashboard creates a policy without sending
      // actionTemplateId (e.g., the email connection flow).
      const inferredTemplate = getActionTemplatesForService(connection.service)
        .sort((a, b) => b.scopes.length - a.scopes.length)[0];

      if (inferredTemplate && body.policyTier) {
        try {
          const policyConfig = generatePolicyFromTemplate(inferredTemplate.id, body.policyTier);
          policyValues = {
            agentId: body.agentId,
            connectionId: body.connectionId,
            actionTemplateId: inferredTemplate.id,
            allowedModels,
            defaultMode: defaultMode as "read_only" | "read_write" | "custom",
            stepUpApproval: policyConfig.stepUpApproval,
            allowlists: policyConfig.allowlists,
            rateLimits: policyConfig.rateLimits,
            timeWindows: policyConfig.timeWindows,
            rules: policyConfig.rules,
            securityPreset: body.securityPreset ?? body.policyTier ?? null,
          };
        } catch {
          // Fall through to manual defaults
          const defaultAllowlists = getDefaultAllowlistsForService(connection.service);
          policyValues = {
            agentId: body.agentId,
            connectionId: body.connectionId,
            actionTemplateId: inferredTemplate.id,
            allowedModels,
            defaultMode: defaultMode as "read_only" | "read_write" | "custom",
            stepUpApproval: stepUpApproval as "always" | "risk_based" | "never",
            allowlists: defaultAllowlists,
            rateLimits: null,
            timeWindows: [],
            rules: { request: [], response: [] },
            securityPreset: body.securityPreset ?? null,
          };
        }
      } else {
        // No template and no preset — use manual defaults
        const defaultAllowlists = getDefaultAllowlistsForService(connection.service);
        policyValues = {
          agentId: body.agentId,
          connectionId: body.connectionId,
          allowedModels,
          defaultMode: defaultMode as "read_only" | "read_write" | "custom",
          stepUpApproval: stepUpApproval as "always" | "risk_based" | "never",
          allowlists: defaultAllowlists,
          rateLimits: null,
          timeWindows: [],
          rules: { request: [], response: [] },
          securityPreset: body.securityPreset ?? null,
        };
      }
    }

    const [policy] = await db
      .insert(policies)
      .values(policyValues)
      .returning({
        id: policies.id,
        agentId: policies.agentId,
        connectionId: policies.connectionId,
        allowedModels: policies.allowedModels,
        defaultMode: policies.defaultMode,
        stepUpApproval: policies.stepUpApproval,
        allowlists: policies.allowlists,
        rateLimits: policies.rateLimits,
        timeWindows: policies.timeWindows,
        rules: policies.rules,
        providerConstraints: policies.providerConstraints,
        securityPreset: policies.securityPreset,
        createdAt: policies.createdAt,
        updatedAt: policies.updatedAt,
      });

    request.log.info(
      { policyId: policy!.id, agentId: body.agentId, connectionId: body.connectionId, defaultMode: policy!.defaultMode, securityPreset: policy!.securityPreset },
      "policy.created",
    );

    // Async audit log
    logPolicyCreated(sub, body.agentId, body.connectionId, { policyId: policy!.id });

    return reply.code(201).send({ policy: policy! });
  });

  /**
   * GET /policies
   * Lists policies for the current workspace.
   * Joins agents and connections to verify workspace scope.
   */
  fastify.get("/policies", {
    schema: {
      tags: ["Policies"],
      summary: "List policies",
      description: "Returns all policies for the current workspace (scoped through agents).",
      response: {
        200: {
          type: "object",
          properties: {
            policies: { type: "array", items: policyResponse },
          },
        },
      },
    },
  }, async (request) => {
    const { wid } = request.user;

    // Get all agents and connections for this workspace to scope policies
    const workspaceAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.workspaceId, wid));

    const agentIds = workspaceAgents.map((a) => a.id);

    if (agentIds.length === 0) {
      return { policies: [] };
    }

    const { inArray } = await import("drizzle-orm");

    const rows = await db
      .select({
        id: policies.id,
        agentId: policies.agentId,
        connectionId: policies.connectionId,
        connectionLabel: connections.label,
        connectionProvider: connections.provider,
        status: policies.status,
        allowedModels: policies.allowedModels,
        defaultMode: policies.defaultMode,
        stepUpApproval: policies.stepUpApproval,
        allowlists: policies.allowlists,
        rateLimits: policies.rateLimits,
        timeWindows: policies.timeWindows,
        rules: policies.rules,
        providerConstraints: policies.providerConstraints,
        securityPreset: policies.securityPreset,
        createdAt: policies.createdAt,
        updatedAt: policies.updatedAt,
      })
      .from(policies)
      .leftJoin(connections, eq(policies.connectionId, connections.id))
      .where(and(inArray(policies.agentId, agentIds), eq(policies.status, "active")))
      .orderBy(policies.createdAt);

    return { policies: rows };
  });

  /**
   * PUT /policies/:id
   * Updates a policy.
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update policy",
        description: "Updates execution model, access mode, or approval settings for a policy.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          properties: {
            allowedModels: { type: "array", items: { type: "string", enum: ["A", "B"] } },
            defaultMode: { type: "string", enum: ["read_only", "read_write", "custom"] },
            stepUpApproval: { type: "string", enum: ["always", "risk_based", "never"] },
            securityPreset: { type: "string", enum: ["minimal", "standard", "strict"] },
          },
        },
        response: {
          200: { type: "object", properties: { policy: policyResponse } },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as {
        allowedModels?: string[];
        defaultMode?: string;
        stepUpApproval?: string;
        securityPreset?: string;
      };
      request.log.info({ action: "update", policyId: id }, "policy.update");

      // Find the policy and verify it belongs to this workspace
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      // Build update fields
      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (body.allowedModels) {
        for (const m of body.allowedModels) {
          if (m !== "A" && m !== "B") {
            return reply.code(400).send({ error: "allowedModels must contain only 'A' or 'B'" });
          }
        }
        // Enforce service-level model restrictions
        const [policyConn] = await db
          .select({ service: connections.service })
          .from(policies)
          .innerJoin(connections, eq(policies.connectionId, connections.id))
          .where(eq(policies.id, id))
          .limit(1);
        if (policyConn) {
          const serviceAllowed = getAllowedModelsForService(policyConn.service as ServiceId);
          for (const m of body.allowedModels) {
            if (!serviceAllowed.includes(m as "A" | "B")) {
              const serviceName = SERVICE_CATALOG[policyConn.service as ServiceId]?.displayName ?? policyConn.service;
              return reply.code(400).send({
                error: `Model ${m} is not supported for ${serviceName}. Allowed: ${serviceAllowed.join(", ")}`,
              });
            }
          }
        }
        updates["allowedModels"] = body.allowedModels;
      }

      if (body.defaultMode) {
        const validModes = ["read_only", "read_write", "custom"];
        if (!validModes.includes(body.defaultMode)) {
          return reply.code(400).send({ error: "defaultMode must be one of: read_only, read_write, custom" });
        }
        updates["defaultMode"] = body.defaultMode;
      }

      if (body.stepUpApproval) {
        const validApprovals = ["always", "risk_based", "never"];
        if (!validApprovals.includes(body.stepUpApproval)) {
          return reply.code(400).send({ error: "stepUpApproval must be one of: always, risk_based, never" });
        }
        updates["stepUpApproval"] = body.stepUpApproval;
      }

      if (body.securityPreset) {
        const validPresets = ["minimal", "standard", "strict"];
        if (!validPresets.includes(body.securityPreset)) {
          return reply.code(400).send({ error: "securityPreset must be one of: minimal, standard, strict" });
        }
        updates["securityPreset"] = body.securityPreset;

        // Regenerate full policy config from template when tier changes
        const [policyWithTemplate] = await db
          .select({ actionTemplateId: policies.actionTemplateId, service: connections.service })
          .from(policies)
          .innerJoin(connections, eq(policies.connectionId, connections.id))
          .where(eq(policies.id, id))
          .limit(1);

        if (policyWithTemplate?.actionTemplateId) {
          try {
            const policyConfig = generatePolicyFromTemplate(
              policyWithTemplate.actionTemplateId,
              body.securityPreset as PolicyTier,
            );
            updates["allowlists"] = policyConfig.allowlists;
            updates["rateLimits"] = policyConfig.rateLimits;
            updates["timeWindows"] = policyConfig.timeWindows;
            updates["rules"] = policyConfig.rules;
            updates["stepUpApproval"] = policyConfig.stepUpApproval;
            updates["defaultMode"] = policyConfig.rules ? "custom" : (body.defaultMode ?? "read_only");
          } catch (err) {
            request.log.error({ err, actionTemplateId: policyWithTemplate.actionTemplateId, preset: body.securityPreset }, "policy.update.template_regen_failed");
          }
        }
      }

      const [updated] = await db
        .update(policies)
        .set(updates)
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      // Invalidate compiled rules cache (local + broadcast to other replicas)
      invalidatePolicyCache(id);
      broadcastPolicyCacheInvalidation(id);

      // Async audit log
      logPolicyUpdated(sub, existing.agentId, null, { policyId: id, changes: body });

      return { policy: updated! };
    },
  );

  /**
   * PUT /policies/:id/allowlists
   * Updates the allowlist configuration for a policy.
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id/allowlists",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update policy allowlists",
        description: "Sets the allowlist rules for a policy. Each entry defines a base URL (HTTPS required), allowed HTTP methods, and path patterns with wildcard support.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["allowlists"],
          properties: {
            allowlists: {
              type: "array",
              items: {
                type: "object",
                required: ["baseUrl", "methods", "pathPatterns"],
                properties: {
                  baseUrl: { type: "string", format: "uri", description: "HTTPS base URL" },
                  methods: { type: "array", items: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] } },
                  pathPatterns: { type: "array", items: { type: "string" }, description: "Path patterns with wildcard support (e.g., /users/me/messages/*)" },
                },
              },
            },
          },
        },
        response: {
          200: { type: "object", properties: { policy: policyResponse } },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as {
        allowlists?: Array<{
          baseUrl?: string;
          methods?: string[];
          pathPatterns?: string[];
        }>;
      };

      if (!Array.isArray(body.allowlists)) {
        return reply.code(400).send({ error: "allowlists must be an array" });
      }

      // Validate each allowlist entry
      const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"] as const;
      for (const entry of body.allowlists) {
        if (!entry.baseUrl || typeof entry.baseUrl !== "string") {
          return reply.code(400).send({ error: "Each allowlist entry requires a baseUrl" });
        }
        // Validate HTTPS
        try {
          const url = new URL(entry.baseUrl);
          if (url.protocol !== "https:") {
            return reply.code(400).send({ error: `Base URL must use HTTPS: ${entry.baseUrl}` });
          }
        } catch {
          return reply.code(400).send({ error: `Invalid base URL: ${entry.baseUrl}` });
        }

        if (!Array.isArray(entry.methods) || entry.methods.length === 0) {
          return reply.code(400).send({ error: "Each allowlist entry requires at least one HTTP method" });
        }
        for (const method of entry.methods) {
          if (!validMethods.includes(method as typeof validMethods[number])) {
            return reply
              .code(400)
              .send({ error: `Invalid HTTP method: ${method}. Must be one of: ${validMethods.join(", ")}` });
          }
        }

        if (!Array.isArray(entry.pathPatterns) || entry.pathPatterns.length === 0) {
          return reply.code(400).send({ error: "Each allowlist entry requires at least one path pattern" });
        }
        for (const pattern of entry.pathPatterns) {
          if (typeof pattern !== "string" || pattern.length === 0) {
            return reply.code(400).send({ error: "Path patterns must be non-empty strings" });
          }
        }
      }

      // Find the policy and verify it belongs to this workspace
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      const [updated] = await db
        .update(policies)
        .set({
          allowlists: body.allowlists,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      // Async audit log
      logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
        policyId: id,
        change: "allowlists",
        entryCount: body.allowlists.length,
      });

      return { policy: updated! };
    },
  );

  /**
   * PUT /policies/:id/rate-limits
   * Updates rate limits and size constraints for a policy.
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id/rate-limits",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update policy rate limits",
        description: "Sets rate limits and size constraints for a policy. Pass null to remove rate limits.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          properties: {
            rateLimits: {
              type: "object",
              nullable: true,
              properties: {
                maxRequestsPerHour: { type: "integer", minimum: 1, description: "Maximum requests per hour per agent+connection" },
                maxPayloadSizeBytes: { type: "integer", minimum: 1, description: "Maximum request payload size in bytes" },
                maxResponseSizeBytes: { type: "integer", minimum: 1, description: "Maximum response size in bytes" },
              },
            },
          },
        },
        response: {
          200: { type: "object", properties: { policy: policyResponse } },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as {
        rateLimits?: {
          maxRequestsPerHour?: number;
          maxPayloadSizeBytes?: number;
          maxResponseSizeBytes?: number;
        } | null;
      };

      // Validate rate limits
      if (body.rateLimits !== null && body.rateLimits !== undefined) {
        if (
          body.rateLimits.maxRequestsPerHour !== undefined &&
          (typeof body.rateLimits.maxRequestsPerHour !== "number" ||
            body.rateLimits.maxRequestsPerHour <= 0 ||
            !Number.isInteger(body.rateLimits.maxRequestsPerHour))
        ) {
          return reply.code(400).send({ error: "maxRequestsPerHour must be a positive integer" });
        }
        if (
          body.rateLimits.maxPayloadSizeBytes !== undefined &&
          (typeof body.rateLimits.maxPayloadSizeBytes !== "number" ||
            body.rateLimits.maxPayloadSizeBytes <= 0 ||
            !Number.isInteger(body.rateLimits.maxPayloadSizeBytes))
        ) {
          return reply.code(400).send({ error: "maxPayloadSizeBytes must be a positive integer" });
        }
        if (
          body.rateLimits.maxResponseSizeBytes !== undefined &&
          (typeof body.rateLimits.maxResponseSizeBytes !== "number" ||
            body.rateLimits.maxResponseSizeBytes <= 0 ||
            !Number.isInteger(body.rateLimits.maxResponseSizeBytes))
        ) {
          return reply.code(400).send({ error: "maxResponseSizeBytes must be a positive integer" });
        }
        if (body.rateLimits.maxRequestsPerHour === undefined) {
          return reply.code(400).send({ error: "maxRequestsPerHour is required when setting rate limits" });
        }
      }

      // Find the policy and verify workspace
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      const [updated] = await db
        .update(policies)
        .set({
          rateLimits: body.rateLimits ?? null,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      // Async audit log
      logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
        policyId: id,
        change: "rate_limits",
      });

      return { policy: updated! };
    },
  );

  /**
   * PUT /policies/:id/time-windows
   * Updates time window constraints for a policy.
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id/time-windows",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update policy time windows",
        description: "Sets time-based access constraints. Execution is blocked outside allowed windows.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["timeWindows"],
          properties: {
            timeWindows: {
              type: "array",
              items: {
                type: "object",
                required: ["dayOfWeek", "startHour", "endHour", "timezone"],
                properties: {
                  dayOfWeek: { type: "integer", minimum: 0, maximum: 6, description: "0=Sunday, 6=Saturday" },
                  startHour: { type: "integer", minimum: 0, maximum: 23 },
                  endHour: { type: "integer", minimum: 0, maximum: 23 },
                  timezone: { type: "string", description: "IANA timezone (e.g., America/New_York)" },
                },
              },
            },
          },
        },
        response: {
          200: { type: "object", properties: { policy: policyResponse } },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as {
        timeWindows?: Array<{
          dayOfWeek?: number;
          startHour?: number;
          endHour?: number;
          timezone?: string;
        }>;
      };

      if (!Array.isArray(body.timeWindows)) {
        return reply.code(400).send({ error: "timeWindows must be an array" });
      }

      // Validate each time window entry
      for (const tw of body.timeWindows) {
        if (
          tw.dayOfWeek === undefined ||
          typeof tw.dayOfWeek !== "number" ||
          !Number.isInteger(tw.dayOfWeek) ||
          tw.dayOfWeek < 0 ||
          tw.dayOfWeek > 6
        ) {
          return reply
            .code(400)
            .send({ error: "dayOfWeek must be an integer between 0 (Sunday) and 6 (Saturday)" });
        }

        if (
          tw.startHour === undefined ||
          typeof tw.startHour !== "number" ||
          !Number.isInteger(tw.startHour) ||
          tw.startHour < 0 ||
          tw.startHour > 23
        ) {
          return reply.code(400).send({ error: "startHour must be an integer between 0 and 23" });
        }

        if (
          tw.endHour === undefined ||
          typeof tw.endHour !== "number" ||
          !Number.isInteger(tw.endHour) ||
          tw.endHour < 0 ||
          tw.endHour > 23
        ) {
          return reply.code(400).send({ error: "endHour must be an integer between 0 and 23" });
        }

        if (!tw.timezone || typeof tw.timezone !== "string" || tw.timezone.trim().length === 0) {
          return reply.code(400).send({ error: "timezone is required and must be a non-empty string (e.g., 'America/New_York')" });
        }

        // Validate timezone is a known IANA timezone
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tw.timezone });
        } catch {
          return reply.code(400).send({ error: `Invalid timezone: ${tw.timezone}` });
        }
      }

      // Find the policy and verify workspace
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      const [updated] = await db
        .update(policies)
        .set({
          timeWindows: body.timeWindows,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      // Async audit log
      logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
        policyId: id,
        change: "time_windows",
        windowCount: body.timeWindows.length,
      });

      return { policy: updated! };
    },
  );

  /**
   * GET /policies/:id/rules
   * Returns the request and response rules for a policy.
   */
  fastify.get<{ Params: { id: string } }>(
    "/policies/:id/rules",
    {
      schema: {
        tags: ["Policies"],
        summary: "Get policy rules",
        description: "Returns the request evaluation and response filtering rules for a policy.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        response: {
          200: {
            type: "object",
            properties: {
              rules: {
                type: "object",
                properties: {
                  request: { type: "array", items: { type: "object", additionalProperties: true } },
                  response: { type: "array", items: { type: "object", additionalProperties: true } },
                },
              },
            },
          },
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      const [existing] = await db
        .select({ id: policies.id, rules: policies.rules })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      const rules = (existing.rules ?? { request: [], response: [] }) as PolicyRules;
      return { rules };
    },
  );

  /**
   * PUT /policies/:id/rules
   * Replaces the request and response rules for a policy.
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id/rules",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update policy rules",
        description:
          "Sets the request evaluation and response filtering rules for a policy. " +
          "Request rules are evaluated pre-execution (first match wins: allow/deny/require_approval). " +
          "Response rules filter the provider response before returning to the agent.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["rules"],
          properties: {
            rules: {
              type: "object",
              required: ["request", "response"],
              properties: {
                request: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["match", "action"],
                    properties: {
                      label: { type: "string" },
                      match: {
                        type: "object",
                        properties: {
                          methods: { type: "array", items: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] } },
                          urlPattern: { type: "string" },
                          body: {
                            type: "array",
                            items: {
                              type: "object",
                              required: ["path", "op"],
                              properties: {
                                path: { type: "string" },
                                op: { type: "string", enum: ["eq", "neq", "in", "not_in", "contains", "matches", "exists"] },
                                value: {},
                              },
                            },
                          },
                        },
                      },
                      action: { type: "string", enum: ["allow", "deny", "require_approval"] },
                    },
                  },
                },
                response: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["match", "filter"],
                    properties: {
                      label: { type: "string" },
                      match: {
                        type: "object",
                        properties: {
                          urlPattern: { type: "string" },
                          methods: { type: "array", items: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] } },
                        },
                      },
                      filter: {
                        type: "object",
                        properties: {
                          allowFields: { type: "array", items: { type: "string" } },
                          denyFields: { type: "array", items: { type: "string" } },
                          redact: {
                            type: "array",
                            items: {
                              type: "object",
                              required: ["type"],
                              properties: {
                                type: {
                                  type: "string",
                                  enum: [
                                    // Group aliases (expand to multiple recognizers)
                                    "all_pii", "contact", "financial", "identity",
                                    // Individual recognizers
                                    "email", "phone", "credit_card", "iban", "ip_address",
                                    "url", "crypto_wallet", "date_of_birth", "mac_address",
                                    "us_ssn", "us_itin", "us_passport", "us_driver_license", "us_bank_routing", "us_npi",
                                    "uk_nhs", "uk_nino",
                                    "it_fiscal_code", "it_vat", "it_passport", "it_identity_card", "it_driver_license",
                                    "in_aadhaar", "in_pan",
                                    "es_nif", "es_nie",
                                    "au_tfn", "au_abn",
                                    "pl_pesel", "fi_pic", "th_tnin", "kr_rrn", "sg_fin",
                                    // Legacy aliases
                                    "ssn",
                                    // Custom regex-based
                                    "custom",
                                  ],
                                },
                                pattern: { type: "string" },
                                replacement: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              policy: policyResponse,
            },
          },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as { rules?: unknown };

      // Validate with Zod
      const parsed = PolicyRulesSchema.safeParse(body.rules);
      if (!parsed.success) {
        return reply.code(400).send({ error: `Invalid rules: ${parsed.error.issues[0]?.message ?? "validation failed"}` });
      }

      // Validate regex patterns compile safely
      const validationError = validateRules(parsed.data);
      if (validationError) {
        return reply.code(400).send({ error: `Invalid rules: ${validationError}` });
      }

      // Find policy and verify workspace
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      const [updated] = await db
        .update(policies)
        .set({
          rules: parsed.data,
          updatedAt: new Date(),
        })
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      // Invalidate compiled rules cache (local + broadcast to other replicas)
      invalidatePolicyCache(id);
      broadcastPolicyCacheInvalidation(id);

      // Async audit log
      logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
        policyId: id,
        change: "rules",
        requestRuleCount: parsed.data.request.length,
        responseRuleCount: parsed.data.response.length,
      });

      return { policy: updated! };
    },
  );

  /**
   * PUT /policies/:id/provider-constraints
   * Sets provider-specific constraints (e.g., Telegram chat IDs, Teams tenant/channel IDs).
   */
  fastify.put<{ Params: { id: string } }>(
    "/policies/:id/provider-constraints",
    {
      schema: {
        tags: ["Policies"],
        summary: "Update provider constraints",
        description:
          "Sets provider-specific access constraints for a policy. " +
          "Telegram: allowedChatIds (default-deny — messages blocked if no IDs configured). " +
          "Microsoft: allowedTenantIds, allowedChatIds, allowedChannelIds (only enforced if set). " +
          "Slack: allowedChannelIds, allowedUserIds (only enforced if set). " +
          "Pass null to clear constraints.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        body: {
          type: "object",
          required: ["providerConstraints"],
          properties: {
            providerConstraints: {
              oneOf: [
                { type: "null" },
                {
                  type: "object",
                  required: ["provider", "allowedChatIds"],
                  properties: {
                    provider: { type: "string", enum: ["telegram"] },
                    allowedChatIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Telegram chat IDs to allow" },
                  },
                },
                {
                  type: "object",
                  required: ["provider"],
                  properties: {
                    provider: { type: "string", enum: ["microsoft"] },
                    allowedTenantIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Microsoft tenant IDs to allow" },
                    allowedChatIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Teams chat IDs to allow" },
                    allowedChannelIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Teams channel IDs to allow" },
                  },
                },
                {
                  type: "object",
                  required: ["provider"],
                  properties: {
                    provider: { type: "string", enum: ["slack"] },
                    allowedChannelIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Slack channel IDs to allow" },
                    allowedUserIds: { type: "array", items: { type: "string", minLength: 1 }, description: "Slack user IDs to allow" },
                  },
                },
              ],
            },
          },
        },
        response: {
          200: { type: "object", properties: { policy: policyResponse } },
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      const body = request.body as { providerConstraints?: unknown };

      // Allow null to clear constraints
      if (body.providerConstraints === null) {
        const [existing] = await db
          .select({
            id: policies.id,
            agentId: policies.agentId,
            connectionId: policies.connectionId,
          })
          .from(policies)
          .innerJoin(agents, eq(policies.agentId, agents.id))
          .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
          .limit(1);

        if (!existing) {
          return reply.code(404).send({ error: "Policy not found" });
        }

        const [updated] = await db
          .update(policies)
          .set({ providerConstraints: null, updatedAt: new Date() })
          .where(eq(policies.id, id))
          .returning({
            id: policies.id,
            agentId: policies.agentId,
            connectionId: policies.connectionId,
            allowedModels: policies.allowedModels,
            defaultMode: policies.defaultMode,
            stepUpApproval: policies.stepUpApproval,
            allowlists: policies.allowlists,
            rateLimits: policies.rateLimits,
            timeWindows: policies.timeWindows,
            rules: policies.rules,
            providerConstraints: policies.providerConstraints,
            securityPreset: policies.securityPreset,
            createdAt: policies.createdAt,
            updatedAt: policies.updatedAt,
          });

        broadcastPolicyCacheInvalidation(id);

        logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
          policyId: id,
          change: "provider_constraints",
          cleared: true,
        });

        return { policy: updated! };
      }

      // Validate with Zod
      const parsed = ProviderConstraintsSchema.safeParse(body.providerConstraints);
      if (!parsed.success) {
        return reply.code(400).send({
          error: `Invalid provider constraints: ${parsed.error.issues[0]?.message ?? "validation failed"}`,
        });
      }

      // Find policy and its connection to validate provider match
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          connectionProvider: connections.provider,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .innerJoin(connections, eq(policies.connectionId, connections.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      // Validate provider matches the connection
      if (parsed.data.provider !== existing.connectionProvider) {
        return reply.code(400).send({
          error: `Provider mismatch: constraints are for "${parsed.data.provider}" but connection uses "${existing.connectionProvider}"`,
        });
      }

      const [updated] = await db
        .update(policies)
        .set({ providerConstraints: parsed.data, updatedAt: new Date() })
        .where(eq(policies.id, id))
        .returning({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
          allowedModels: policies.allowedModels,
          defaultMode: policies.defaultMode,
          stepUpApproval: policies.stepUpApproval,
          allowlists: policies.allowlists,
          rateLimits: policies.rateLimits,
          timeWindows: policies.timeWindows,
          rules: policies.rules,
          providerConstraints: policies.providerConstraints,
          securityPreset: policies.securityPreset,
          createdAt: policies.createdAt,
          updatedAt: policies.updatedAt,
        });

      broadcastPolicyCacheInvalidation(id);

      logPolicyUpdated(sub, existing.agentId, existing.connectionId, {
        policyId: id,
        change: "provider_constraints",
        provider: parsed.data.provider,
      });

      return { policy: updated! };
    },
  );

  /**
   * DELETE /policies/:id
   * Removes a policy.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/policies/:id",
    {
      schema: {
        tags: ["Policies"],
        summary: "Delete policy",
        description: "Removes a policy binding. The agent will no longer have access through this connection.",
        params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
        response: {
          200: { type: "object", properties: { deleted: { type: "boolean" } } },
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ action: "delete", policyId: id }, "policy.delete");

      // Find the policy and verify workspace ownership
      const [existing] = await db
        .select({
          id: policies.id,
          agentId: policies.agentId,
          connectionId: policies.connectionId,
        })
        .from(policies)
        .innerJoin(agents, eq(policies.agentId, agents.id))
        .where(and(eq(policies.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!existing) {
        return reply.code(404).send({ error: "Policy not found" });
      }

      await db.delete(policies).where(eq(policies.id, id));
      invalidatePolicyCache(id);
      broadcastPolicyCacheInvalidation(id);

      // Async audit log
      logPolicyDeleted(sub, existing.agentId, existing.connectionId, { policyId: id });

      return { deleted: true };
    },
  );
}
