import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { db } from "../db/client";
import { agentPermissionRequests, agents, pendingConnections, policies, connections } from "../db/schema";
import { eq, and } from "drizzle-orm";
import {
  SERVICE_CATALOG,
  getProviderForService,
  getDefaultScopes,
  type PolicyTier,
  type ServiceId,
  isValidActionTemplateId,
  getActionTemplate,
} from "@agenthifive/contracts";
import { requireScope } from "../utils/require-scope";
import { logEvent } from "../services/audit";
import { createNotification } from "../services/notifications";
import { sendPushNotificationsForWorkspace } from "../services/push-notifications";
import { resolveConnector } from "../utils/oauth-connector-factory";

const WEB_URL = process.env["WEB_URL"] || "http://localhost:3000";
const PENDING_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Map action template ID to service ID.
 * Derives from ACTION_TEMPLATES in contracts — never goes out of sync.
 */
function getServiceIdFromActionTemplate(actionTemplateId: string): string {
  const template = getActionTemplate(actionTemplateId);
  return template?.serviceId ?? actionTemplateId;
}

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const permissionRequestProperties = {
  id: { type: "string" as const, format: "uuid" },
  agentId: { type: "string" as const, format: "uuid" },
  agentName: { type: "string" as const },
  actionTemplateId: { type: "string" as const },
  reason: { type: "string" as const },
  status: { type: "string" as const, enum: ["pending", "approved", "denied", "expired"] },
  connectionId: { type: "string" as const, format: "uuid", nullable: true },
  resolvedAt: { type: "string" as const, format: "date-time", nullable: true },
  requestedAt: { type: "string" as const, format: "date-time" },
};

export default async function agentPermissionRequestsRoutes(fastify: FastifyInstance) {
  /**
   * GET /agent-permission-requests
   * List all pending permission requests for the current workspace
   */
  fastify.get("/agent-permission-requests", {
    schema: {
      tags: ["Agent Permission Requests"],
      summary: "List permission requests",
      description: "Lists permission requests from agents in the current workspace. By default returns only pending requests. Use ?status=all to include resolved requests.",
      querystring: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "all"], description: "Filter by status (default: pending)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            requests: {
              type: "array",
              items: {
                type: "object",
                properties: permissionRequestProperties,
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { wid: workspaceId } = request.user;
    const query = request.query as { status?: string };
    const filterPending = query.status !== "all";

    const whereConditions = [eq(agentPermissionRequests.workspaceId, workspaceId)];
    if (filterPending) {
      whereConditions.push(eq(agentPermissionRequests.status, "pending"));
    }

    const requests = await db
      .select({
        id: agentPermissionRequests.id,
        agentId: agentPermissionRequests.agentId,
        agentName: agents.name,
        actionTemplateId: agentPermissionRequests.actionTemplateId,
        reason: agentPermissionRequests.reason,
        status: agentPermissionRequests.status,
        connectionId: agentPermissionRequests.connectionId,
        resolvedAt: agentPermissionRequests.resolvedAt,
        requestedAt: agentPermissionRequests.createdAt,
      })
      .from(agentPermissionRequests)
      .innerJoin(agents, eq(agentPermissionRequests.agentId, agents.id))
      .where(and(...whereConditions))
      .orderBy(agentPermissionRequests.createdAt);

    return { requests };
  });

  /**
   * POST /agent-permission-requests/:id/approve
   * Approve a permission request with a selected policy tier
   * Initiates OAuth flow to create a connection and policy
   */
  fastify.post("/agent-permission-requests/:id/approve", {
    schema: {
      tags: ["Agent Permission Requests"],
      summary: "Approve permission request",
      description: "Approves a permission request. For OAuth services, initiates an OAuth flow. For bot_token/api_key services, returns a redirect URL to the connection setup form.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Permission request ID" },
        },
      },
      body: {
        type: "object",
        properties: {
          policyTier: {
            type: "string",
            enum: ["strict", "standard", "minimal"],
            description: "Policy tier to apply. When omitted, the frontend handles policy creation via PolicyWizard after the connection is created.",
          },
          allowedModels: {
            type: "array",
            items: { type: "string", enum: ["A", "B"] },
            description: "Execution models to allow (defaults to ['B'])",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            credentialType: { type: "string", enum: ["oauth", "bot_token", "api_key"] },
            pendingConnectionId: { type: "string", format: "uuid" },
            authorizationUrl: { type: "string", format: "uri" },
            service: { type: "string" },
            redirectUrl: { type: "string" },
          },
        },
        404: errorResponse,
        403: errorResponse,
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { wid: workspaceId } = request.user;
    const body = request.body as {
      policyTier?: PolicyTier;
      allowedModels?: string[];
    };

    // Fetch the permission request
    const [permissionRequest] = await db
      .select()
      .from(agentPermissionRequests)
      .where(and(
        eq(agentPermissionRequests.id, id),
        eq(agentPermissionRequests.workspaceId, workspaceId),
      ))
      .limit(1);

    if (!permissionRequest) {
      return reply.code(404).send({ error: "Permission request not found" });
    }

    // Map action template ID to service ID
    const serviceId = getServiceIdFromActionTemplate(permissionRequest.actionTemplateId);
    const catalogEntry = SERVICE_CATALOG[serviceId as keyof typeof SERVICE_CATALOG];
    if (!catalogEntry) {
      return reply.code(400).send({ error: `Invalid service for action template: ${permissionRequest.actionTemplateId}` });
    }

    // Branch on credential type: bot_token/api_key skip OAuth entirely
    if (catalogEntry.credentialType !== "oauth") {
      // When policyTier is provided, return redirectUrl for legacy flow
      if (body.policyTier) {
        const params = new URLSearchParams({
          service: serviceId,
          agentId: permissionRequest.agentId,
          actionTemplateId: permissionRequest.actionTemplateId,
          policyTier: body.policyTier,
          permissionRequestId: id,
          allowedModels: (body.allowedModels || ["B"]).join(","),
        });
        return {
          credentialType: catalogEntry.credentialType,
          service: serviceId,
          redirectUrl: `/dashboard/connections?${params.toString()}`,
        };
      }
      // New flow: frontend handles credential form + PolicyWizard locally
      return {
        credentialType: catalogEntry.credentialType,
        service: serviceId,
      };
    }

    // --- OAuth flow below ---

    // Check if there's already a pending connection for this permission request
    const allPending = await db
      .select()
      .from(pendingConnections)
      .where(eq(pendingConnections.workspaceId, workspaceId));

    const existingPending = allPending.find((p) => {
      const meta = p.metadata as { permissionRequestId?: string } | null;
      return meta?.permissionRequestId === id;
    });

    if (existingPending) {
      const existingMeta = existingPending.metadata as { byaOauthAppId?: string } | null;
      const { connector } = await resolveConnector({
        provider: existingPending.provider,
        oauthAppId: existingMeta?.byaOauthAppId,
        workspaceId,
      });
      const { authorizationUrl } = await connector.createAuthorizationUrl({
        redirectUri: `${WEB_URL}/api/connections/callback`,
        scopes: existingPending.scopes,
        state: existingPending.state!,
        codeChallenge: createHash("sha256")
          .update(existingPending.codeVerifier!)
          .digest("base64url"),
        codeChallengeMethod: "S256",
      });

      return {
        credentialType: "oauth" as const,
        pendingConnectionId: existingPending.id,
        authorizationUrl,
      };
    }

    const provider = getProviderForService(serviceId as ServiceId);
    const actionTemplate = getActionTemplate(permissionRequest.actionTemplateId);
    // Use the action template's scopes if available — these are the minimum scopes
    // the agent actually requested (e.g. gmail-read = readonly only, not send).
    // Fall back to service default scopes only if no action template is found.
    const scopes = (actionTemplate?.scopes?.length ?? 0) > 0
      ? actionTemplate!.scopes
      : getDefaultScopes(serviceId as ServiceId);
    const label = actionTemplate
      ? `${catalogEntry.displayName} - ${actionTemplate.label}`
      : `${catalogEntry.displayName} connection`;

    const { connector, oauthAppId } = await resolveConnector({ provider, workspaceId });
    const expiresAt = new Date(Date.now() + PENDING_EXPIRY_MS);

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const redirectUri = `${WEB_URL}/api/connections/callback`;

    const { authorizationUrl } = await connector.createAuthorizationUrl({
      redirectUri,
      scopes,
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const [pending] = await db
      .insert(pendingConnections)
      .values({
        provider: provider as "google" | "microsoft",
        service: serviceId as ServiceId,
        workspaceId,
        state,
        codeVerifier,
        scopes,
        label,
        metadata: {
          redirectUri,
          agentId: permissionRequest.agentId,
          actionTemplateId: permissionRequest.actionTemplateId,
          ...(body.policyTier ? { policyTier: body.policyTier } : {}),
          permissionRequestId: id,
          allowedModels: body.allowedModels || ["B"],
          ...(oauthAppId && { byaOauthAppId: oauthAppId }),
        },
        expiresAt,
      })
      .returning({ id: pendingConnections.id });

    return {
      credentialType: "oauth" as const,
      pendingConnectionId: pending!.id,
      authorizationUrl,
    };
  });

  /**
   * DELETE /agent-permission-requests/:id
   * Deny a permission request (marks as denied, does not delete)
   */
  fastify.delete("/agent-permission-requests/:id", {
    schema: {
      tags: ["Agent Permission Requests"],
      summary: "Deny permission request",
      description: "Marks a permission request as denied. The request is preserved for audit history. Only pending requests from the current workspace can be denied.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Permission request ID" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            success: { type: "boolean" },
          },
        },
        404: errorResponse,
        403: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { wid: workspaceId } = request.user;

    const [permissionRequest] = await db
      .select()
      .from(agentPermissionRequests)
      .where(eq(agentPermissionRequests.id, id))
      .limit(1);

    if (!permissionRequest) {
      return reply.code(404).send({ error: "Permission request not found" });
    }

    if (permissionRequest.workspaceId !== workspaceId) {
      return reply.code(403).send({ error: "Forbidden" });
    }

    // Mark as denied instead of deleting
    await db
      .update(agentPermissionRequests)
      .set({ status: "denied", resolvedAt: new Date() })
      .where(eq(agentPermissionRequests.id, id));

    return { success: true };
  });

  /**
   * PATCH /agent-permission-requests/:id/approve-complete
   * Mark a permission request as approved after the connection has been created.
   * Used by the frontend for non-OAuth flows (bot_token, api_key).
   */
  fastify.patch("/agent-permission-requests/:id/approve-complete", {
    schema: {
      tags: ["Agent Permission Requests"],
      summary: "Mark permission request as approved",
      description: "Marks a pending permission request as approved with a reference to the created connection. Used after non-OAuth connection setup.",
      params: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", format: "uuid", description: "Permission request ID" },
        },
      },
      body: {
        type: "object",
        required: ["connectionId"],
        properties: {
          connectionId: { type: "string", format: "uuid", description: "The created connection ID" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            success: { type: "boolean" },
          },
        },
        404: errorResponse,
        403: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { wid: workspaceId } = request.user;
    const { connectionId } = request.body as { connectionId: string };

    const [permissionRequest] = await db
      .select()
      .from(agentPermissionRequests)
      .where(and(
        eq(agentPermissionRequests.id, id),
        eq(agentPermissionRequests.workspaceId, workspaceId),
      ))
      .limit(1);

    if (!permissionRequest) {
      return reply.code(404).send({ error: "Permission request not found" });
    }

    await db
      .update(agentPermissionRequests)
      .set({
        status: "approved",
        connectionId,
        resolvedAt: new Date(),
      })
      .where(eq(agentPermissionRequests.id, id));

    return { success: true };
  });

  /**
   * POST /agent-permission-requests
   * Agent-initiated: request access to a capability.
   * Requires capabilities:request scope (agent API key).
   */
  fastify.post("/agent-permission-requests", {
    preHandler: [requireScope("capabilities:request")],
    schema: {
      tags: ["Agent Permission Requests"],
      summary: "Request capability access",
      description:
        "Agent-initiated request for access to a specific action template. " +
        "The workspace owner will be notified and can approve or deny the request. " +
        "Returns 409 if the agent already has a pending request or an active policy for this action.",
      body: {
        type: "object",
        required: ["actionTemplateId", "reason"],
        properties: {
          actionTemplateId: { type: "string", description: "Action template ID (e.g., gmail-read, teams-manage)" },
          reason: { type: "string", minLength: 1, maxLength: 500, description: "Why the agent needs this capability" },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            actionTemplateId: { type: "string" },
            reason: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        400: errorResponse,
        403: errorResponse,
        409: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid: workspaceId, agentId } = request.user;
    const { actionTemplateId, reason } = request.body as { actionTemplateId: string; reason: string };

    if (!agentId) {
      return reply.code(403).send({ error: "This endpoint is only available to agents (use an agent API key)" });
    }

    // Validate action template ID
    if (!isValidActionTemplateId(actionTemplateId)) {
      return reply.code(400).send({ error: `Unknown action template: ${actionTemplateId}` });
    }

    // Dedup: check for existing pending request with same agent + actionTemplateId
    const [existingRequest] = await db
      .select({ id: agentPermissionRequests.id })
      .from(agentPermissionRequests)
      .where(
        and(
          eq(agentPermissionRequests.agentId, agentId),
          eq(agentPermissionRequests.actionTemplateId, actionTemplateId),
          eq(agentPermissionRequests.status, "pending"),
        ),
      )
      .limit(1);

    if (existingRequest) {
      return reply.code(409).send({ error: "A pending request for this action already exists" });
    }

    // Dedup: check if agent already has an active policy for this action
    // Only block if the connection is healthy (not revoked or needs_reauth)
    const [existingPolicy] = await db
      .select({ id: policies.id })
      .from(policies)
      .innerJoin(connections, eq(policies.connectionId, connections.id))
      .where(
        and(
          eq(policies.agentId, agentId),
          eq(policies.actionTemplateId, actionTemplateId),
          eq(connections.status, "healthy"),
        ),
      )
      .limit(1);

    if (existingPolicy) {
      return reply.code(409).send({ error: "Agent already has access to this action" });
    }

    // Create the permission request
    const [created] = await db
      .insert(agentPermissionRequests)
      .values({
        agentId,
        workspaceId,
        actionTemplateId,
        reason,
      })
      .returning({
        id: agentPermissionRequests.id,
        actionTemplateId: agentPermissionRequests.actionTemplateId,
        reason: agentPermissionRequests.reason,
        createdAt: agentPermissionRequests.createdAt,
      }) as [{ id: string; actionTemplateId: string; reason: string; createdAt: Date }];

    // Fire-and-forget: audit log
    logEvent({
      actor: `agent:${agentId}`,
      agentId,
      action: "permission_requested",
      decision: "allowed",
      metadata: { actionTemplateId, reason },
    });

    // Fire-and-forget: look up agent name and create notification
    db.select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then(([agent]) => {
        const template = getActionTemplate(actionTemplateId);
        const agentName = agent?.name ?? "An agent";
        const actionLabel = template?.label ?? actionTemplateId;
        createNotification({
          workspaceId,
          type: "permission_request",
          title: `${agentName} requests access`,
          body: `${agentName} wants to "${actionLabel}". Reason: ${reason}`,
          linkUrl: "/dashboard/approvals",
          metadata: { agentId, actionTemplateId, permissionRequestId: created.id },
        });
        sendPushNotificationsForWorkspace(workspaceId, {
          title: `${agentName} requests access`,
          body: `${agentName} wants to "${actionLabel}". Reason: ${reason}`,
          data: {
            type: "permission_request",
            permissionRequestId: created.id,
            url: "/dashboard/approvals",
          },
        });
      })
      .catch((err) => { fastify.log.error({ err, permissionRequestId: created.id }, "Failed to create permission request notification"); });

    return reply.code(201).send(created);
  });
}
