import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "../db/schema/agents";
import { agentBootstrapSecrets } from "../db/schema/agent-bootstrap-secrets";
import { agentAccessTokens } from "../db/schema/agent-access-tokens";
import { policies } from "../db/schema/policies";
import {
  logAgentUpdated,
  logAgentDeleted,
  logAgentDisabled,
  logAgentEnabled,
} from "../services/audit";
import { broadcastPolicyCacheInvalidation } from "../services/pg-listeners";

const BOOTSTRAP_SECRET_TTL_HOURS = Number(process.env["BOOTSTRAP_SECRET_TTL_HOURS"]) || 1;

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const agentProperties = {
  id: { type: "string" as const, format: "uuid" },
  name: { type: "string" as const },
  description: { type: "string" as const },
  iconUrl: { type: "string" as const, nullable: true },
  status: { type: "string" as const, enum: ["created", "active", "disabled"] },
  enrolledAt: { type: "string" as const, format: "date-time", nullable: true },
  createdAt: { type: "string" as const, format: "date-time" },
};

export default async function agentRoutes(fastify: FastifyInstance) {
  /**
   * POST /agents
   * Creates an agent with name, description, optional icon URL.
   * Always generates a bootstrap secret for agent onboarding.
   */
  fastify.post("/agents", {
    schema: {
      tags: ["Agents"],
      summary: "Create agent",
      description:
        "Registers a new agent in the current workspace. Returns a bootstrap secret " +
        "(shown only once) for the agent to register its public key.",
      body: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, description: "Agent name" },
          description: { type: "string", description: "Agent description" },
          iconUrl: { type: "string", format: "uri", description: "URL of the agent icon" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            agent: { type: "object", properties: agentProperties },
            bootstrapSecret: {
              type: "string",
              description: "Bootstrap secret — only returned on creation, never retrievable later. Expires in 1 hour.",
            },
          },
        },
        400: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      name?: string;
      description?: string;
      iconUrl?: string;
    };
    request.log.info({ action: "create", name: body.name }, "agent.create");

    if (!body.name || typeof body.name !== "string" || body.name.trim().length === 0) {
      return reply.code(400).send({ error: "name is required and must be a non-empty string" });
    }

    const description = body.description ?? "";
    const iconUrl = body.iconUrl ?? null;

    // Generate bootstrap secret
    const bootstrapSecret = `ah5b_${randomBytes(32).toString("base64url")}`;
    const secretHash = createHash("sha256").update(bootstrapSecret).digest("hex");

    const [agent] = await db
      .insert(agents)
      .values({
        name: body.name.trim(),
        description,
        workspaceId: wid,
        iconUrl,
      })
      .returning({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        iconUrl: agents.iconUrl,
        status: agents.status,
        enrolledAt: agents.enrolledAt,
        createdAt: agents.createdAt,
      });

    // Insert bootstrap secret
    await db.insert(agentBootstrapSecrets).values({
      agentId: agent!.id,
      type: "bootstrap",
      secretHash,
      expiresAt: new Date(Date.now() + BOOTSTRAP_SECRET_TTL_HOURS * 60 * 60 * 1000),
    });

    request.log.info({ agentId: agent!.id, name: agent!.name }, "agent.created");

    return {
      agent: agent!,
      bootstrapSecret,
    };
  });

  /**
   * GET /agents
   * Lists agents for the current workspace.
   */
  fastify.get("/agents", {
    schema: {
      tags: ["Agents"],
      summary: "List agents",
      description: "Returns all agents registered in the current workspace.",
      response: {
        200: {
          type: "object",
          properties: {
            agents: {
              type: "array",
              items: { type: "object", properties: agentProperties },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { wid } = request.user;

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        iconUrl: agents.iconUrl,
        status: agents.status,
        enrolledAt: agents.enrolledAt,
        createdAt: agents.createdAt,
      })
      .from(agents)
      .where(eq(agents.workspaceId, wid))
      .orderBy(agents.createdAt);

    return { agents: rows };
  });

  /**
   * GET /agents/:id
   * Returns agent details for a specific agent in the current workspace.
   */
  fastify.get<{ Params: { id: string } }>(
    "/agents/:id",
    {
      schema: {
        tags: ["Agents"],
        summary: "Get agent by ID",
        description: "Returns details for a specific agent in the current workspace.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              agent: {
                type: "object",
                properties: {
                  ...agentProperties,
                  updatedAt: { type: "string", format: "date-time" },
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

      const [agent] = await db
        .select({
          id: agents.id,
          name: agents.name,
          description: agents.description,
          iconUrl: agents.iconUrl,
          status: agents.status,
          enrolledAt: agents.enrolledAt,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      return { agent };
    },
  );

  /**
   * PUT /agents/:id
   * Updates agent name, description, and/or iconUrl.
   */
  fastify.put<{ Params: { id: string } }>(
    "/agents/:id",
    {
      schema: {
        tags: ["Agents"],
        summary: "Update agent",
        description: "Updates the name, description, or icon URL of an agent. At least one field must be provided.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, description: "Agent name" },
            description: { type: "string", description: "Agent description" },
            iconUrl: { type: "string", format: "uri", nullable: true, description: "URL of the agent icon (null to clear)" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              agent: {
                type: "object",
                properties: {
                  ...agentProperties,
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
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
      const body = request.body as {
        name?: string;
        description?: string;
        iconUrl?: string | null;
      };
      request.log.info({ agentId: id, action: "update" }, "agent.update");

      // Build the update set — at least one field required
      const updates: Record<string, unknown> = {};
      const changedFields: string[] = [];

      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length === 0) {
          return reply.code(400).send({ error: "name must be a non-empty string" });
        }
        updates["name"] = body.name.trim();
        changedFields.push("name");
      }
      if (body.description !== undefined) {
        updates["description"] = body.description;
        changedFields.push("description");
      }
      if (body.iconUrl !== undefined) {
        updates["iconUrl"] = body.iconUrl;
        changedFields.push("iconUrl");
      }

      if (changedFields.length === 0) {
        return reply.code(400).send({ error: "At least one field (name, description, iconUrl) must be provided" });
      }

      updates["updatedAt"] = new Date();

      const [updated] = await db
        .update(agents)
        .set(updates)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .returning({
          id: agents.id,
          name: agents.name,
          description: agents.description,
          iconUrl: agents.iconUrl,
          status: agents.status,
          enrolledAt: agents.enrolledAt,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        });

      if (!updated) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      logAgentUpdated(sub, id, { fields: changedFields });

      return { agent: updated };
    },
  );

  /**
   * POST /agents/:id/bootstrap-secret
   * Generates a bootstrap secret for agent onboarding or key rotation.
   * Works for both "created" (first enrollment) and "active" (re-keying) agents.
   */
  fastify.post<{ Params: { id: string } }>(
    "/agents/:id/bootstrap-secret",
    {
      schema: {
        tags: ["Agents"],
        summary: "Generate bootstrap secret",
        description:
          "Generates a bootstrap secret for agent onboarding or key rotation. " +
          "Works for agents in 'created' or 'active' status. Expires in 1 hour.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              bootstrapSecret: { type: "string", description: "Bootstrap secret — shown only once" },
            },
          },
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      if (agent.status === "disabled") {
        return reply.code(409).send({ error: "Agent is disabled" });
      }

      const bootstrapSecret = `ah5b_${randomBytes(32).toString("base64url")}`;
      const secretHash = createHash("sha256").update(bootstrapSecret).digest("hex");

      await db.insert(agentBootstrapSecrets).values({
        agentId: id,
        type: "bootstrap",
        secretHash,
        expiresAt: new Date(Date.now() + BOOTSTRAP_SECRET_TTL_HOURS * 60 * 60 * 1000),
      });

      return { bootstrapSecret };
    },
  );

  /**
   * POST /agents/:id/disable
   * Disables an agent — revokes all access tokens immediately.
   */
  fastify.post<{ Params: { id: string } }>(
    "/agents/:id/disable",
    {
      schema: {
        tags: ["Agents"],
        summary: "Disable agent",
        description: "Disables an agent and revokes all its access tokens immediately.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              tokensRevoked: { type: "number" },
            },
          },
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ agentId: id, action: "disable" }, "agent.disable");

      const [agent] = await db
        .select({ id: agents.id, status: agents.status })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      if (agent.status === "disabled") {
        return reply.code(409).send({ error: "Agent is already disabled" });
      }

      const now = new Date();

      // Disable agent
      await db
        .update(agents)
        .set({ status: "disabled", disabledAt: now, updatedAt: now })
        .where(eq(agents.id, id));

      // Revoke all access tokens
      const deleted = await db
        .delete(agentAccessTokens)
        .where(eq(agentAccessTokens.agentId, id))
        .returning({ id: agentAccessTokens.id });

      // Invalidate policy cache for all this agent's policies across all replicas
      const agentPolicies = await db
        .select({ id: policies.id })
        .from(policies)
        .where(eq(policies.agentId, id));
      for (const p of agentPolicies) {
        broadcastPolicyCacheInvalidation(p.id);
      }

      logAgentDisabled(sub, id, { tokensRevoked: deleted.length });

      return { success: true, tokensRevoked: deleted.length };
    },
  );

  /**
   * POST /agents/:id/enable
   * Re-enables a disabled agent.
   */
  fastify.post<{ Params: { id: string } }>(
    "/agents/:id/enable",
    {
      schema: {
        tags: ["Agents"],
        summary: "Enable agent",
        description:
          "Re-enables a disabled agent. If the agent has a registered public key, " +
          "status becomes 'active'. Otherwise, status becomes 'created' (needs re-enrollment).",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              status: { type: "string", enum: ["created", "active"] },
            },
          },
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ agentId: id, action: "enable" }, "agent.enable");

      const [agent] = await db
        .select({ id: agents.id, status: agents.status, publicKeyJwk: agents.publicKeyJwk })
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .limit(1);

      if (!agent) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      if (agent.status !== "disabled") {
        return reply.code(409).send({ error: "Agent is not disabled" });
      }

      const newStatus = agent.publicKeyJwk ? "active" : "created";
      const now = new Date();

      await db
        .update(agents)
        .set({ status: newStatus, disabledAt: null, updatedAt: now })
        .where(eq(agents.id, id));

      logAgentEnabled(sub, id, { newStatus });

      return { success: true, status: newStatus };
    },
  );

  /**
   * DELETE /agents/:id
   * Deletes an agent. Cascading FKs remove associated policies and approval requests.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/agents/:id",
    {
      schema: {
        tags: ["Agents"],
        summary: "Delete agent",
        description: "Permanently deletes an agent and all its associated policies and approval requests (via cascading foreign keys).",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Agent ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { success: { type: "boolean" as const } },
          },
          404: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ agentId: id, action: "delete" }, "agent.delete");

      const result = await db
        .delete(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, wid)))
        .returning({ id: agents.id, name: agents.name });

      if (result.length === 0) {
        return reply.code(404).send({ error: "Agent not found" });
      }

      logAgentDeleted(sub, id, { name: result[0]!.name });

      return { success: true };
    },
  );
}
