import type { FastifyInstance } from "fastify";
import { eq, and, lte, desc, sql } from "drizzle-orm";
import { db } from "../db/client";
import { approvalRequests } from "../db/schema/approval-requests";
import { agents } from "../db/schema/agents";
import { connections } from "../db/schema/connections";
import { promptHistoryQuarantines } from "../db/schema/prompt-history-quarantines";
import { logApprovalApproved, logApprovalDenied, logApprovalExpired } from "../services/audit";
import { editTelegramApprovalMessage } from "../services/external-notifications";

/**
 * Scrub sensitive fields from requestDetails after the approval is resolved.
 * Keeps only method + url for history; removes PII excerpts, body metadata,
 * guard trigger matches, and any other ephemeral context.
 */
function scrubRequestDetails(approvalId: string) {
  db.update(approvalRequests)
    .set({
      requestDetails: sql`jsonb_build_object(
        'method', ${approvalRequests.requestDetails}->'method',
        'url', ${approvalRequests.requestDetails}->'url',
        'requestFingerprint', ${approvalRequests.requestDetails}->'requestFingerprint'
      )`,
      updatedAt: new Date(),
    })
    .where(eq(approvalRequests.id, approvalId))
    .then(() => {})
    .catch((err) => { console.error("[approvals] Failed to scrub request details", { err, approvalId }); });
}

function normalizeGuardExcerpt(excerpt: string): string {
  return excerpt.replace(/^\.\.\./, "").replace(/\.\.\.$/, "").trim();
}

async function createPromptHistoryQuarantine(params: {
  approvalId: string;
  workspaceId: string;
  resolution: "approved" | "denied" | "expired";
  requestDetails: Record<string, unknown>;
}) {
  const sessionKey = typeof params.requestDetails.sessionKey === "string"
    ? params.requestDetails.sessionKey
    : null;
  const guardTrigger = params.requestDetails.guardTrigger as {
    type?: string;
    matches?: Array<{ excerpt?: string }>;
  } | undefined;
  if (!sessionKey || guardTrigger?.type !== "prompt_injection") return;

  const fragments = (guardTrigger.matches ?? [])
    .map((match) => (typeof match.excerpt === "string" ? normalizeGuardExcerpt(match.excerpt) : ""))
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return;

  await db.insert(promptHistoryQuarantines)
    .values({
      workspaceId: params.workspaceId,
      sessionKey,
      approvalRequestId: params.approvalId,
      resolution: params.resolution,
      fragments,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: promptHistoryQuarantines.approvalRequestId,
      set: {
        resolution: params.resolution,
        fragments,
        updatedAt: new Date(),
      },
    });
}

export default async function approvalRoutes(fastify: FastifyInstance) {
  /**
   * GET /approvals
   * List pending approval requests for the current workspace.
   */
  fastify.get("/approvals", {
    schema: {
      tags: ["Approvals"],
      summary: "List approval requests",
      description: "Returns all approval requests for the current workspace, including pending, approved, denied, and expired.",
      response: {
        200: {
          type: "object",
          properties: {
            approvals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  policyId: { type: "string", format: "uuid" },
                  agentId: { type: "string", format: "uuid" },
                  connectionId: { type: "string", format: "uuid" },
                  actor: { type: "string" },
                  status: { type: "string", enum: ["pending", "approved", "denied", "expired", "consumed"] },
                  requestDetails: { type: "object", additionalProperties: true, description: "Method, URL, headers, body of the original request" },
                  expiresAt: { type: "string", format: "date-time" },
                  createdAt: { type: "string", format: "date-time" },
                  agentName: { type: "string" },
                  connectionLabel: { type: "string" },
                  reason: { type: "string", nullable: true, description: "Why this approval was required (rule label or step-up reason)" },
                  connectionProvider: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { wid } = request.user;

    // Expire stale approval requests and scrub their sensitive metadata (fire-and-forget)
    db.update(approvalRequests)
      .set({
        status: "expired",
        requestDetails: sql`jsonb_build_object(
          'method', ${approvalRequests.requestDetails}->'method',
          'url', ${approvalRequests.requestDetails}->'url'
        )`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approvalRequests.workspaceId, wid),
          sql`status = 'pending'`,
          lte(approvalRequests.expiresAt, new Date()),
        ),
      )
      .then(() => {})
      .catch((err) => fastify.log.error(err, "Failed to expire stale approval requests"));

    const rows = await db
      .select({
        id: approvalRequests.id,
        policyId: approvalRequests.policyId,
        agentId: approvalRequests.agentId,
        connectionId: approvalRequests.connectionId,
        actor: approvalRequests.actor,
        status: approvalRequests.status,
        requestDetails: approvalRequests.requestDetails,
        reason: approvalRequests.reason,
        expiresAt: approvalRequests.expiresAt,
        createdAt: approvalRequests.createdAt,
        agentName: agents.name,
        connectionLabel: connections.label,
        connectionProvider: connections.provider,
      })
      .from(approvalRequests)
      .innerJoin(agents, eq(approvalRequests.agentId, agents.id))
      .innerJoin(connections, eq(approvalRequests.connectionId, connections.id))
      .where(eq(approvalRequests.workspaceId, wid))
      .orderBy(desc(approvalRequests.createdAt));

    // Mark expired rows in the response (in case the fire-and-forget hasn't completed yet)
    const now = new Date();
    const approvals = rows.map((row) => ({
      ...row,
      status: row.status === "pending" && row.expiresAt <= now ? "expired" as const : row.status,
    }));

    return { approvals };
  });

  /**
   * GET /approvals/:id
   * Returns details for a single approval request.
   */
  fastify.get<{ Params: { id: string } }>(
    "/approvals/:id",
    {
      schema: {
        tags: ["Approvals"],
        summary: "Get approval by ID",
        description: "Returns details for a specific approval request, including agent and connection information.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Approval request ID" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              approval: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  policyId: { type: "string", format: "uuid" },
                  agentId: { type: "string", format: "uuid" },
                  connectionId: { type: "string", format: "uuid" },
                  actor: { type: "string" },
                  status: { type: "string", enum: ["pending", "approved", "denied", "expired", "consumed"] },
                  requestDetails: { type: "object", additionalProperties: true },
                  expiresAt: { type: "string", format: "date-time" },
                  createdAt: { type: "string", format: "date-time" },
                  agentName: { type: "string" },
                  connectionLabel: { type: "string" },
                  reason: { type: "string", nullable: true, description: "Why this approval was required" },
                  connectionProvider: { type: "string" },
                },
              },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      const [row] = await db
        .select({
          id: approvalRequests.id,
          policyId: approvalRequests.policyId,
          agentId: approvalRequests.agentId,
          connectionId: approvalRequests.connectionId,
          actor: approvalRequests.actor,
          status: approvalRequests.status,
          requestDetails: approvalRequests.requestDetails,
          reason: approvalRequests.reason,
          expiresAt: approvalRequests.expiresAt,
          createdAt: approvalRequests.createdAt,
          agentName: agents.name,
          connectionLabel: connections.label,
          connectionProvider: connections.provider,
        })
        .from(approvalRequests)
        .innerJoin(agents, eq(approvalRequests.agentId, agents.id))
        .innerJoin(connections, eq(approvalRequests.connectionId, connections.id))
        .where(
          and(
            eq(approvalRequests.id, id),
            eq(approvalRequests.workspaceId, wid),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.code(404).send({ error: "Approval request not found" });
      }

      // Mark expired in response if pending and past expiry
      const now = new Date();
      const approval = {
        ...row,
        status: row.status === "pending" && row.expiresAt <= now ? "expired" as const : row.status,
      };

      return { approval };
    },
  );

  /**
   * POST /approvals/:id/approve
   * Approve a pending request. The agent can then re-submit via vault/execute
   * with the approvalId to bypass the guard and execute.
   */
  fastify.post<{ Params: { id: string } }>(
    "/approvals/:id/approve",
    {
      schema: {
        tags: ["Approvals"],
        summary: "Approve request",
        description: "Approves a pending step-up approval request. The agent can then re-submit the original request via POST /vault/execute with the approvalId to execute it.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid", description: "Approval request ID" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              approved: { type: "boolean" },
              approvalRequestId: { type: "string", format: "uuid" },
              auditId: { type: "string", format: "uuid" },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
          410: { type: "object", properties: { error: { type: "string" }, auditId: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ approvalId: id, action: "approve" }, "approval.approve");

      const [approval] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, id),
            eq(approvalRequests.workspaceId, wid),
          ),
        )
        .limit(1);

      if (!approval) {
        return reply.code(404).send({ error: "Approval request not found" });
      }

      if (approval.status !== "pending") {
        return reply.code(409).send({ error: `Approval request is already ${approval.status}` });
      }

      // Check if expired
      if (approval.expiresAt <= new Date()) {
        await createPromptHistoryQuarantine({
          approvalId: id,
          workspaceId: wid,
          resolution: "expired",
          requestDetails: approval.requestDetails as Record<string, unknown>,
        });
        await db
          .update(approvalRequests)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(approvalRequests.id, id));

        scrubRequestDetails(id);

        const { auditId } = logApprovalExpired(sub, approval.agentId, approval.connectionId, {
          approvalRequestId: id,
        });

        editTelegramApprovalMessage(id, "expired");

        return reply.code(410).send({ error: "Approval request has expired", auditId });
      }

      // Mark as approved
      await createPromptHistoryQuarantine({
        approvalId: id,
        workspaceId: wid,
        resolution: "approved",
        requestDetails: approval.requestDetails as Record<string, unknown>,
      });
      await db
        .update(approvalRequests)
        .set({ status: "approved", updatedAt: new Date() })
        .where(eq(approvalRequests.id, id));

      // Scrub sensitive metadata now that the decision is made (fire-and-forget)
      scrubRequestDetails(id);

      request.log.info({ approvalId: id, agentId: approval.agentId, connectionId: approval.connectionId }, "approval.approved");

      // Log approval event
      const { auditId } = logApprovalApproved(sub, approval.agentId, approval.connectionId, {
        approvalRequestId: id,
      });

      // Update Telegram notification message (fire-and-forget)
      editTelegramApprovalMessage(id, "approved");

      return { approved: true, approvalRequestId: id, auditId };
    },
  );

  /**
   * POST /approvals/:id/deny
   * Deny a pending approval request.
   */
  fastify.post<{ Params: { id: string } }>(
    "/approvals/:id/deny",
    {
      schema: {
        tags: ["Approvals"],
        summary: "Deny request",
        description: "Denies a pending step-up approval request. The original action is not executed.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid", description: "Approval request ID" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              denied: { type: "boolean" },
              approvalRequestId: { type: "string", format: "uuid" },
              auditId: { type: "string", format: "uuid" },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
          410: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;
      request.log.info({ approvalId: id, action: "deny" }, "approval.deny");

      const [approval] = await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.id, id),
            eq(approvalRequests.workspaceId, wid),
          ),
        )
        .limit(1);

      if (!approval) {
        return reply.code(404).send({ error: "Approval request not found" });
      }

      if (approval.status !== "pending") {
        return reply.code(409).send({ error: `Approval request is already ${approval.status}` });
      }

      // Check if expired
      if (approval.expiresAt <= new Date()) {
        await createPromptHistoryQuarantine({
          approvalId: id,
          workspaceId: wid,
          resolution: "expired",
          requestDetails: approval.requestDetails as Record<string, unknown>,
        });
        await db
          .update(approvalRequests)
          .set({ status: "expired", updatedAt: new Date() })
          .where(eq(approvalRequests.id, id));

        scrubRequestDetails(id);
        editTelegramApprovalMessage(id, "expired");

        return reply.code(410).send({ error: "Approval request has expired" });
      }

      // Mark as denied
      await createPromptHistoryQuarantine({
        approvalId: id,
        workspaceId: wid,
        resolution: "denied",
        requestDetails: approval.requestDetails as Record<string, unknown>,
      });
      await db
        .update(approvalRequests)
        .set({ status: "denied", updatedAt: new Date() })
        .where(eq(approvalRequests.id, id));

      // Scrub sensitive metadata now that the decision is made (fire-and-forget)
      scrubRequestDetails(id);

      request.log.info({ approvalId: id, agentId: approval.agentId, connectionId: approval.connectionId }, "approval.denied");

      // Log denial event
      const { auditId } = logApprovalDenied(sub, approval.agentId, approval.connectionId, {
        approvalRequestId: id,
      });

      // Update Telegram notification message (fire-and-forget)
      editTelegramApprovalMessage(id, "denied");

      return { denied: true, approvalRequestId: id, auditId };
    },
  );
}
