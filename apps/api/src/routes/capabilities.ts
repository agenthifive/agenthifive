import type { FastifyInstance } from "fastify";
import { eq, and, ne } from "drizzle-orm";
import {
  SERVICE_CATALOG,
  ACTION_TEMPLATES,
  type ActionTemplate,
  type ServiceId,
} from "@agenthifive/contracts";
import { db } from "../db/client";
import { connections } from "../db/schema/connections";
import { policies } from "../db/schema/policies";
import { agents } from "../db/schema/agents";
import { agentPermissionRequests } from "../db/schema/agent-permission-requests";
import { requireScope } from "../utils/require-scope";
import { hasOAuthCredentials } from "../utils/oauth-connector-factory";

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

export default async function capabilityRoutes(fastify: FastifyInstance) {
  /**
   * GET /capabilities/services
   * Returns the full service catalog with per-service action templates.
   * Static data — no database query.
   */
  fastify.get("/capabilities/services", {
    preHandler: [requireScope("capabilities:read")],
    schema: {
      tags: ["Capabilities"],
      summary: "List available services and actions",
      description:
        "Returns the complete AgentHiFive service catalog with available action templates per service. " +
        "Use this to discover what services can be connected and what actions are available. " +
        "Requires the capabilities:read scope.",
      response: {
        200: {
          type: "object",
          properties: {
            services: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  provider: { type: "string" },
                  icon: { type: "string" },
                  singleton: { type: "boolean" },
                  actions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        label: { type: "string" },
                        description: { type: "string" },
                        requiresApproval: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
            oauthStatus: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  available: { type: "boolean" },
                  source: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        403: errorResponse,
      },
    },
  }, async (request) => {
    const { wid } = request.user;

    const services = Object.entries(SERVICE_CATALOG).map(([id, svc]) => {
      const actions = ACTION_TEMPLATES
        .filter((t) => t.serviceId === id)
        .map((t) => ({
          id: t.id,
          label: t.label,
          description: t.description,
          requiresApproval: t.requiresApproval,
        }));

      return {
        id,
        name: svc.displayName,
        provider: svc.provider,
        icon: svc.icon,
        singleton: svc.singleton,
        actions,
      };
    });

    // Check OAuth credential availability for providers that need it
    const [google, microsoft] = await Promise.all([
      hasOAuthCredentials("google", wid),
      hasOAuthCredentials("microsoft", wid),
    ]);

    return {
      services,
      oauthStatus: { google, microsoft },
    };
  });

  /**
   * GET /capabilities/me
   * Returns the calling agent's current capability status:
   * - activeConnections: connections with policies for this agent
   * - pendingRequests: this agent's pending permission requests
   * - availableActions: action templates NOT covered by active connections or pending requests
   */
  fastify.get("/capabilities/me", {
    preHandler: [requireScope("capabilities:read")],
    schema: {
      tags: ["Capabilities"],
      summary: "Get my capabilities",
      description:
        "Returns the calling agent's current capability status including active connections, " +
        "pending permission requests, and available actions not yet requested. " +
        "Requires the capabilities:read scope and an agent API key.",
      response: {
        200: {
          type: "object",
          properties: {
            activeConnections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  connectionId: { type: "string", format: "uuid", nullable: true },
                  service: { type: "string" },
                  provider: { type: "string" },
                  status: { type: "string" },
                  credentialType: { type: "string" },
                  category: { type: "string" },
                  displayName: { type: "string" },
                  label: { type: "string" },
                  actionTemplateId: { type: "string" },
                },
              },
            },
            pendingRequests: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  actionTemplateId: { type: "string" },
                  reason: { type: "string" },
                  requestedAt: { type: "string", format: "date-time" },
                },
              },
            },
            availableActions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  serviceId: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                  requiresApproval: { type: "boolean" },
                },
              },
            },
          },
        },
        403: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { wid: workspaceId, agentId } = request.user;

    if (!agentId) {
      return reply.code(403).send({ error: "This endpoint is only available to agents (use an agent API key)" });
    }

    // Active connections: policies joined with connections (exclude revoked)
    const activeRows = await db
      .select({
        connectionId: connections.id,
        service: connections.service,
        provider: connections.provider,
        status: connections.status,
        label: connections.label,
        actionTemplateId: policies.actionTemplateId,
      })
      .from(policies)
      .innerJoin(connections, eq(policies.connectionId, connections.id))
      .where(
        and(
          eq(policies.agentId, agentId),
          eq(connections.workspaceId, workspaceId),
          ne(connections.status, "revoked"),
        ),
      );

    // Pending requests for this agent (only unresolved ones)
    const pendingRows = await db
      .select({
        id: agentPermissionRequests.id,
        actionTemplateId: agentPermissionRequests.actionTemplateId,
        reason: agentPermissionRequests.reason,
        requestedAt: agentPermissionRequests.createdAt,
      })
      .from(agentPermissionRequests)
      .where(
        and(
          eq(agentPermissionRequests.agentId, agentId),
          eq(agentPermissionRequests.workspaceId, workspaceId),
          eq(agentPermissionRequests.status, "pending"),
        ),
      );

    // Available actions = all templates minus those covered by active connections or pending requests
    const coveredTemplateIds = new Set([
      ...activeRows.map((r) => r.actionTemplateId).filter(Boolean),
      ...pendingRows.map((r) => r.actionTemplateId),
    ]);

    const availableActions = ACTION_TEMPLATES
      .filter((t) => !coveredTemplateIds.has(t.id))
      .map((t) => ({
        id: t.id,
        serviceId: t.serviceId,
        label: t.label,
        description: t.description,
        requiresApproval: t.requiresApproval,
      }));

    return {
      activeConnections: activeRows.map((row) => {
        const catalogEntry = SERVICE_CATALOG[row.service as ServiceId];
        const isSingleton = catalogEntry?.singleton ?? false;
        return {
          connectionId: isSingleton ? null : row.connectionId,
          service: row.service,
          provider: row.provider,
          status: row.status,
          credentialType: catalogEntry?.credentialType ?? "oauth",
          category: catalogEntry?.category ?? "data",
          displayName: catalogEntry?.displayName ?? row.service,
          label: row.label,
          actionTemplateId: row.actionTemplateId,
        };
      }),
      pendingRequests: pendingRows,
      availableActions,
    };
  });
}
