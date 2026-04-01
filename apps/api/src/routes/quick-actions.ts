import type { FastifyInstance, FastifyReply } from "fastify";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { approvalRequests } from "../db/schema/approval-requests";
import { logApprovalApproved, logApprovalDenied } from "../services/audit";
import { editTelegramApprovalMessage } from "../services/external-notifications";

const WEB_URL = process.env["WEB_URL"] || process.env["NEXT_PUBLIC_WEB_URL"] || "https://app.agenthifive.com";

export default async function quickActionRoutes(fastify: FastifyInstance) {
  /**
   * GET /quick-action/:token/approve
   * Unauthenticated — token IS the auth. Opens in browser from Telegram inline button.
   */
  fastify.get<{ Params: { token: string } }>(
    "/quick-action/:token/approve",
    {
      config: { skipAuth: true },
      schema: {
        tags: ["Quick Actions"],
        summary: "Quick-approve via token",
        description: "Approves an approval request using a single-use token (from Telegram inline button). Redirects to a result page.",
        security: [],
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      return handleQuickAction(request.params.token, "approve", reply, request.ip);
    },
  );

  /**
   * GET /quick-action/:token/deny
   * Same as approve, but denies.
   */
  fastify.get<{ Params: { token: string } }>(
    "/quick-action/:token/deny",
    {
      config: { skipAuth: true },
      schema: {
        tags: ["Quick Actions"],
        summary: "Quick-deny via token",
        description: "Denies an approval request using a single-use token (from Telegram inline button). Redirects to a result page.",
        security: [],
        params: {
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string", minLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      return handleQuickAction(request.params.token, "deny", reply, request.ip);
    },
  );
}

async function handleQuickAction(
  token: string,
  action: "approve" | "deny",
  reply: FastifyReply,
  clientIp: string,
) {
  const resultUrl = (status: string) =>
    `${WEB_URL}/quick-action/result?status=${status}`;

  // Look up approval by quickActionToken
  const [approval] = await db
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      expiresAt: approvalRequests.expiresAt,
      agentId: approvalRequests.agentId,
      connectionId: approvalRequests.connectionId,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.quickActionToken, token))
    .limit(1);

  if (!approval) {
    return reply.redirect(resultUrl("not_found"));
  }

  // Check if expired
  if (approval.expiresAt <= new Date()) {
    if (approval.status === "pending") {
      db.update(approvalRequests)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(approvalRequests.id, approval.id))
        .catch((err) => { console.error("[quick-actions] Failed to expire approval", { err, approvalId: approval.id }); });
    }
    return reply.redirect(resultUrl("expired"));
  }

  // Check if already resolved
  if (approval.status !== "pending") {
    return reply.redirect(resultUrl(`already_${approval.status}`));
  }

  // Perform the action — optimistic lock with WHERE status = 'pending'
  const newStatus = action === "approve" ? "approved" : "denied";
  const updated = await db
    .update(approvalRequests)
    .set({
      status: newStatus,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(approvalRequests.id, approval.id),
        eq(approvalRequests.status, "pending"),
      ),
    )
    .returning({ id: approvalRequests.id });

  if (updated.length === 0) {
    // Race condition — someone else approved/denied between our SELECT and UPDATE
    return reply.redirect(resultUrl("already_resolved"));
  }

  // Audit log + Telegram message edit (fire-and-forget)
  const actor = `quick-action:${clientIp}`;
  if (action === "approve") {
    logApprovalApproved(actor, approval.agentId, approval.connectionId, {
      approvalRequestId: approval.id,
      via: "telegram",
    });
  } else {
    logApprovalDenied(actor, approval.agentId, approval.connectionId, {
      approvalRequestId: approval.id,
      via: "telegram",
    });
  }
  editTelegramApprovalMessage(approval.id, newStatus);

  return reply.redirect(resultUrl(newStatus));
}
