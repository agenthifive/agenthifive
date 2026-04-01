import type { FastifyInstance } from "fastify";
import { eq, and, gte, lte, lt, or, inArray, desc } from "drizzle-orm";
import { db } from "../db/client";
import { auditEvents } from "../db/schema/audit-events";
import { agents } from "../db/schema/agents";
import { connections } from "../db/schema/connections";

/**
 * Get all agent IDs and connection IDs belonging to a workspace.
 * Used to scope audit events to the current user's workspace.
 */
async function getWorkspaceEntityIds(wid: string) {
  const [agentRows, connectionRows] = await Promise.all([
    db.select({ id: agents.id }).from(agents).where(eq(agents.workspaceId, wid)),
    db.select({ id: connections.id }).from(connections).where(eq(connections.workspaceId, wid)),
  ]);
  return {
    agentIds: agentRows.map((r) => r.id),
    connectionIds: connectionRows.map((r) => r.id),
  };
}

/**
 * Build a workspace-scoping filter for audit events.
 * An event belongs to a workspace if:
 * - actor is the user (sub) OR
 * - agentId belongs to a workspace agent OR
 * - connectionId belongs to a workspace connection
 */
function buildWorkspaceFilter(sub: string, agentIds: string[], connectionIds: string[]) {
  const conditions = [eq(auditEvents.actor, sub)];
  if (agentIds.length > 0) {
    conditions.push(inArray(auditEvents.agentId, agentIds));
  }
  if (connectionIds.length > 0) {
    conditions.push(inArray(auditEvents.connectionId, connectionIds));
  }
  return or(...conditions);
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export default async function auditRoutes(fastify: FastifyInstance) {
  /**
   * GET /audit
   * Paginated audit events for the current workspace.
   * Query params: agentId, connectionId, action, dateFrom, dateTo, cursor, limit
   */
  fastify.get<{
    Querystring: {
      agentId?: string;
      connectionId?: string;
      action?: string;
      dateFrom?: string;
      dateTo?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/audit", {
    schema: {
      tags: ["Audit"],
      summary: "List audit events",
      description: "Returns paginated audit events for the current workspace. Supports cursor-based pagination and filtering.",
      querystring: {
        type: "object",
        properties: {
          agentId: { type: "string", format: "uuid", description: "Filter by agent" },
          connectionId: { type: "string", format: "uuid", description: "Filter by connection" },
          action: { type: "string", description: "Filter by action (e.g., token_vended, execution_completed)" },
          dateFrom: { type: "string", format: "date-time", description: "Start of date range" },
          dateTo: { type: "string", format: "date-time", description: "End of date range" },
          cursor: { type: "string", description: "Cursor (auditId) from previous page" },
          limit: { type: "string", description: "Page size (default 50, max 200)" },
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
                },
              },
            },
            nextCursor: { type: "string", nullable: true, description: "Cursor for next page, or null if last page" },
          },
        },
      },
    },
  }, async (request) => {
    const { wid, sub } = request.user;
    const { agentId, connectionId, action, dateFrom, dateTo, cursor, limit: limitStr } = request.query;

    const pageSize = Math.min(Math.max(Number(limitStr) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const { agentIds, connectionIds } = await getWorkspaceEntityIds(wid);

    // Build conditions
    const conditions = [];

    // Workspace scoping
    const wsFilter = buildWorkspaceFilter(sub, agentIds, connectionIds);
    if (wsFilter) conditions.push(wsFilter);

    // Optional filters
    if (agentId) {
      // Validate agentId belongs to workspace
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
    if (action) {
      conditions.push(eq(auditEvents.action, action));
    }
    if (dateFrom) {
      conditions.push(gte(auditEvents.timestamp, new Date(dateFrom)));
    }
    if (dateTo) {
      conditions.push(lte(auditEvents.timestamp, new Date(dateTo)));
    }

    // Cursor-based pagination: cursor is the auditId of the last item from previous page
    if (cursor) {
      // Get the timestamp of the cursor event
      const [cursorEvent] = await db
        .select({ timestamp: auditEvents.timestamp, id: auditEvents.id })
        .from(auditEvents)
        .where(eq(auditEvents.auditId, cursor))
        .limit(1);

      if (cursorEvent) {
        // Stable cursor pagination (ordered by timestamp DESC, id DESC)
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
    const events = hasMore ? rows.slice(0, pageSize) : rows;
    const nextCursor = hasMore ? events[events.length - 1]!.auditId : null;

    return { events, nextCursor };
  });

  /**
   * GET /audit/export
   * Export audit events as JSON or CSV.
   * Query params: format (json|csv), agentId, connectionId, action, dateFrom, dateTo
   */
  fastify.get<{
    Querystring: {
      format?: string;
      agentId?: string;
      connectionId?: string;
      action?: string;
      dateFrom?: string;
      dateTo?: string;
    };
  }>("/audit/export", {
    schema: {
      tags: ["Audit"],
      summary: "Export audit events",
      description: "Exports all audit events matching filters as JSON or CSV. Supports the same filters as GET /audit but returns the full dataset (no pagination).",
      querystring: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["json", "csv"], default: "json", description: "Export format" },
          agentId: { type: "string", format: "uuid" },
          connectionId: { type: "string", format: "uuid" },
          action: { type: "string" },
          dateFrom: { type: "string", format: "date-time" },
          dateTo: { type: "string", format: "date-time" },
        },
      },
      response: {
        200: {
          description: "JSON array or CSV string depending on format parameter",
        },
        400: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid, sub } = request.user;
    const { format = "json", agentId, connectionId, action, dateFrom, dateTo } = request.query;

    if (format !== "json" && format !== "csv") {
      return reply.code(400).send({ error: "format must be 'json' or 'csv'" });
    }

    const { agentIds, connectionIds } = await getWorkspaceEntityIds(wid);

    const conditions = [];

    const wsFilter = buildWorkspaceFilter(sub, agentIds, connectionIds);
    if (wsFilter) conditions.push(wsFilter);

    if (agentId) {
      if (agentIds.includes(agentId)) {
        conditions.push(eq(auditEvents.agentId, agentId));
      } else {
        if (format === "json") {
          return reply.header("Content-Type", "application/json").send([]);
        }
        return reply
          .header("Content-Type", "text/csv")
          .header("Content-Disposition", "attachment; filename=audit-export.csv")
          .send("audit_id,timestamp,actor,agent_id,connection_id,action,decision,metadata\n");
      }
    }
    if (connectionId) {
      if (connectionIds.includes(connectionId)) {
        conditions.push(eq(auditEvents.connectionId, connectionId));
      } else {
        if (format === "json") {
          return reply.header("Content-Type", "application/json").send([]);
        }
        return reply
          .header("Content-Type", "text/csv")
          .header("Content-Disposition", "attachment; filename=audit-export.csv")
          .send("audit_id,timestamp,actor,agent_id,connection_id,action,decision,metadata\n");
      }
    }
    if (action) {
      conditions.push(eq(auditEvents.action, action));
    }
    if (dateFrom) {
      conditions.push(gte(auditEvents.timestamp, new Date(dateFrom)));
    }
    if (dateTo) {
      conditions.push(lte(auditEvents.timestamp, new Date(dateTo)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
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
      .orderBy(desc(auditEvents.timestamp));

    if (format === "json") {
      return reply
        .header("Content-Type", "application/json")
        .header("Content-Disposition", "attachment; filename=audit-export.json")
        .send(rows);
    }

    // CSV export
    const csvHeader = "audit_id,timestamp,actor,agent_id,connection_id,action,decision,metadata";
    const csvRows = rows.map((row) => {
      const metadataStr = JSON.stringify(row.metadata).replace(/"/g, '""');
      return [
        row.auditId,
        row.timestamp.toISOString(),
        row.actor,
        row.agentId ?? "",
        row.connectionId ?? "",
        row.action,
        row.decision,
        `"${metadataStr}"`,
      ].join(",");
    });

    const csv = [csvHeader, ...csvRows].join("\n");

    return reply
      .header("Content-Type", "text/csv")
      .header("Content-Disposition", "attachment; filename=audit-export.csv")
      .send(csv);
  });
}
