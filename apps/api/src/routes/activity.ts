import type { FastifyInstance } from "fastify";
import { eq, and, gte, lte, lt, or, inArray, desc } from "drizzle-orm";
import { db } from "../db/client";
import { auditEvents } from "../db/schema/audit-events";
import { agents } from "../db/schema/agents";
import { connections } from "../db/schema/connections";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export default async function activityRoutes(fastify: FastifyInstance) {
  /**
   * GET /activity
   * Human-readable activity feed for the current workspace.
   * Returns audit events enriched with agent name, connection label/provider.
   * Query params: agentId, connectionId, dateFrom, dateTo, cursor, limit
   */
  fastify.get<{
    Querystring: {
      agentId?: string;
      connectionId?: string;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/activity", {
    schema: {
      tags: ["Activity"],
      summary: "Activity feed",
      description: "Returns a human-readable activity feed for the current workspace. Events are enriched with agent names and connection details.",
      querystring: {
        type: "object",
        properties: {
          agentId: { type: "string", format: "uuid", description: "Filter by agent" },
          connectionId: { type: "string", format: "uuid", description: "Filter by connection" },
          dateFrom: { type: "string", format: "date-time" },
          dateTo: { type: "string", format: "date-time" },
          cursor: { type: "string", description: "Cursor (auditId) from previous page" },
          limit: { type: "string", description: "Page size (default 30, max 100)" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            events: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  auditId: { type: "string", format: "uuid" },
                  timestamp: { type: "string", format: "date-time" },
                  actor: { type: "string" },
                  agentId: { type: "string", nullable: true },
                  connectionId: { type: "string", nullable: true },
                  action: { type: "string" },
                  decision: { type: "string" },
                  metadata: { type: "object", additionalProperties: true },
                  agentName: { type: "string", nullable: true },
                  connectionLabel: { type: "string", nullable: true },
                  connectionProvider: { type: "string", nullable: true },
                },
              },
            },
            nextCursor: { type: "string", nullable: true },
            filters: {
              type: "object",
              properties: {
                agents: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } } },
                connections: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, provider: { type: "string" } } } },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { wid, sub } = request.user;

    const { agentId, connectionId, dateFrom, dateTo, cursor, limit: limitStr } = request.query;
    const pageSize = Math.min(Math.max(Number(limitStr) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    // Get workspace agent and connection IDs for scoping
    const [agentRows, connectionRows] = await Promise.all([
      db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.workspaceId, wid)),
      db
        .select({
          id: connections.id,
          label: connections.label,
          provider: connections.provider,
          status: connections.status,
        })
        .from(connections)
        .where(eq(connections.workspaceId, wid)),
    ]);

    const agentIds = agentRows.map((r) => r.id);
    const connectionIds = connectionRows.map((r) => r.id);

    // Build name lookup maps
    const agentMap = new Map(agentRows.map((r) => [r.id, r.name]));
    const connectionMap = new Map(
      connectionRows.map((r) => [r.id, { label: r.label, provider: r.provider }]),
    );

    // Build workspace scoping filter
    const scopeConditions = [eq(auditEvents.actor, sub)];
    if (agentIds.length > 0) {
      scopeConditions.push(inArray(auditEvents.agentId, agentIds));
    }
    if (connectionIds.length > 0) {
      scopeConditions.push(inArray(auditEvents.connectionId, connectionIds));
    }
    const wsFilter = or(...scopeConditions);

    const conditions = [];
    if (wsFilter) conditions.push(wsFilter);

    // Optional filters
    if (agentId) {
      if (agentIds.includes(agentId)) {
        conditions.push(eq(auditEvents.agentId, agentId));
      } else {
        return { events: [], nextCursor: null };
      }
    }
    if (connectionId) {
      if (connectionIds.includes(connectionId)) {
        conditions.push(eq(auditEvents.connectionId, connectionId));
      } else {
        return { events: [], nextCursor: null };
      }
    }
    if (dateFrom) {
      conditions.push(gte(auditEvents.timestamp, new Date(dateFrom)));
    }
    if (dateTo) {
      conditions.push(lte(auditEvents.timestamp, new Date(dateTo)));
    }

    // Cursor-based pagination
    if (cursor) {
      const [cursorEvent] = await db
        .select({ timestamp: auditEvents.timestamp, id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.auditId, cursor))
        .limit(1);

      if (cursorEvent) {
        conditions.push(
          or(
            lt(auditEvents.timestamp, cursorEvent.timestamp),
            and(
              eq(auditEvents.timestamp, cursorEvent.timestamp),
              lt(auditEvents.id, cursorEvent.id),
            ),
          )!,
        );
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        id: auditEvents.id,
        auditId: auditEvents.auditId,
        timestamp: auditEvents.timestamp,
        actor: auditEvents.actor,
        agentId: auditEvents.agentId,
        connectionId: auditEvents.connectionId,
        action: auditEvents.action,
        decision: auditEvents.decision,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(whereClause)
      .orderBy(desc(auditEvents.timestamp), desc(auditEvents.id))
      .limit(pageSize + 1);

    const hasMore = rows.length > pageSize;
    const eventRows = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? eventRows[eventRows.length - 1]!.auditId : null;

    // Enrich events with agent name and connection info
    const events = eventRows.map((row) => {
      const connInfo = row.connectionId ? connectionMap.get(row.connectionId) : null;
      return {
        id: row.id,
        auditId: row.auditId,
        timestamp: row.timestamp,
        actor: row.actor,
        agentId: row.agentId,
        connectionId: row.connectionId,
        action: row.action,
        decision: row.decision,
        metadata: row.metadata,
        agentName: row.agentId ? agentMap.get(row.agentId) ?? null : null,
        connectionLabel: connInfo?.label ?? null,
        connectionProvider: connInfo?.provider ?? null,
      };
    });

    // Return agents and connections for filter dropdowns
    // Only show active connections in the dropdown; revoked ones are hidden
    // (events from revoked connections still display with their connection info)
    const activeConnections = connectionRows.filter((c) => c.status !== "revoked");

    return {
      events,
      nextCursor,
      filters: {
        agents: agentRows.map((a) => ({ id: a.id, name: a.name })),
        connections: activeConnections.map((c) => ({
          id: c.id,
          label: c.label,
          provider: c.provider,
        })),
      },
    };
  });
}
