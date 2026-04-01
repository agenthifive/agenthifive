import type { FastifyInstance } from "fastify";
import { eq, and, gte, or, inArray, count } from "drizzle-orm";
import { db } from "../db/client";
import { connections } from "../db/schema/connections";
import { agents } from "../db/schema/agents";
import { auditEvents } from "../db/schema/audit-events";

export default async function dashboardRoutes(fastify: FastifyInstance) {
  /**
   * GET /dashboard/summary
   * Returns aggregate counts for the current workspace dashboard.
   */
  fastify.get("/dashboard/summary", {
    schema: {
      tags: ["Dashboard"],
      summary: "Dashboard summary",
      description: "Returns aggregate counts of connections, agents, and today's activity events for the current workspace.",
      response: {
        200: {
          type: "object",
          additionalProperties: true,
          properties: {
            connections: { type: "integer" },
            agents: { type: "integer" },
            eventsToday: { type: "integer" },
          },
        },
      },
    },
    handler: async (request) => {
      const { wid, sub } = request.user;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      // Counts for connections and agents are straightforward (workspace-scoped).
      // Also fetch agent/connection IDs to scope audit events.
      const [connectionsResult, agentsResult, agentIds, connectionIds] =
        await Promise.all([
          db
            .select({ count: count() })
            .from(connections)
            .where(eq(connections.workspaceId, wid)),
          db
            .select({ count: count() })
            .from(agents)
            .where(eq(agents.workspaceId, wid)),
          db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.workspaceId, wid)),
          db
            .select({ id: connections.id })
            .from(connections)
            .where(eq(connections.workspaceId, wid)),
        ]);

      // Audit events scoped same way as activity route:
      // actor = current user OR agentId in workspace OR connectionId in workspace
      const scopeConditions = [eq(auditEvents.actor, sub)];
      if (agentIds.length > 0) {
        scopeConditions.push(
          inArray(
            auditEvents.agentId,
            agentIds.map((r) => r.id),
          ),
        );
      }
      if (connectionIds.length > 0) {
        scopeConditions.push(
          inArray(
            auditEvents.connectionId,
            connectionIds.map((r) => r.id),
          ),
        );
      }

      const eventsResult = await db
        .select({ count: count() })
        .from(auditEvents)
        .where(
          and(or(...scopeConditions), gte(auditEvents.timestamp, todayStart)),
        );

      return {
        connections: connectionsResult[0]?.count ?? 0,
        agents: agentsResult[0]?.count ?? 0,
        eventsToday: eventsResult[0]?.count ?? 0,
      };
    },
  });
}
