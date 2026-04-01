/**
 * PostgreSQL LISTEN/NOTIFY service for cross-replica communication.
 *
 * Uses the postgres.js `sql.listen()` which auto-creates a dedicated connection
 * and multiplexes all channels on it. Two channels:
 *
 * - `notification_created`: SSE push to all replicas' dashboard subscribers
 * - `policy_cache_invalidate`: policy engine cache invalidation across replicas
 */

import { sql } from "../db/client";
import { invalidatePolicyCache } from "./policy-engine";
import type { FastifyBaseLogger } from "fastify";
type Logger = FastifyBaseLogger;

// ── SSE subscriber management ────────────────────────────────────────

export type SseNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  linkUrl: string | null;
  createdAt: Date;
};

type SseCallback = (notification: SseNotification) => void;

/** In-memory SSE subscribers per workspace (local to this replica) */
const subscribers = new Map<string, Set<SseCallback>>();

/**
 * Subscribe to real-time notifications for a workspace.
 * Returns an unsubscribe function.
 */
export function subscribeToNotifications(
  workspaceId: string,
  callback: SseCallback,
): () => void {
  let subs = subscribers.get(workspaceId);
  if (!subs) {
    subs = new Set();
    subscribers.set(workspaceId, subs);
  }
  subs.add(callback);

  return () => {
    subs!.delete(callback);
    if (subs!.size === 0) {
      subscribers.delete(workspaceId);
    }
  };
}

// ── LISTEN handlers ──────────────────────────────────────────────────

let started = false;

/**
 * Start listening to PostgreSQL NOTIFY channels.
 * Call once at server startup. postgres.js manages the dedicated connection.
 */
export async function startListeners(logger: Logger): Promise<void> {
  if (started) {
    logger.warn("pg-listeners already started");
    return;
  }
  started = true;

  // Channel 1: notification_created — push to SSE subscribers
  await sql.listen("notification_created", (payload) => {
    try {
      const data = JSON.parse(payload) as {
        workspace_id: string;
        id: string;
        type: string;
        title: string;
        body: string;
        link_url: string | null;
        created_at: string;
      };

      const subs = subscribers.get(data.workspace_id);
      if (subs && subs.size > 0) {
        const notification: SseNotification = {
          id: data.id,
          type: data.type,
          title: data.title,
          body: data.body,
          linkUrl: data.link_url,
          createdAt: new Date(data.created_at),
        };
        for (const cb of subs) {
          try {
            cb(notification);
          } catch {
            /* subscriber error — ignore */
          }
        }
      }
    } catch (err) {
      logger.error({ err, payload }, "Failed to parse notification_created payload");
    }
  });

  // Channel 2: policy_cache_invalidate — invalidate local compiled rules cache
  await sql.listen("policy_cache_invalidate", (payload) => {
    try {
      const { policy_id } = JSON.parse(payload) as { policy_id: string };
      invalidatePolicyCache(policy_id);
      logger.debug({ policyId: policy_id }, "Policy cache invalidated via NOTIFY");
    } catch (err) {
      logger.error({ err, payload }, "Failed to parse policy_cache_invalidate payload");
    }
  });

  logger.info("pg-listeners started (notification_created, policy_cache_invalidate)");
}

/**
 * Broadcast a notification to all replicas via NOTIFY.
 * Fire-and-forget — never blocks.
 */
export function broadcastNotification(data: {
  workspaceId: string;
  id: string;
  type: string;
  title: string;
  body: string;
  linkUrl: string | null;
  createdAt: Date;
}): void {
  const payload = JSON.stringify({
    workspace_id: data.workspaceId,
    id: data.id,
    type: data.type,
    title: data.title,
    body: data.body,
    link_url: data.linkUrl,
    created_at: data.createdAt.toISOString(),
  });
  sql.notify("notification_created", payload).catch((err) => {
    console.error("[pg-listen] Failed to broadcast notification_created NOTIFY", err);
  });
}

/**
 * Broadcast a policy cache invalidation to all replicas via NOTIFY.
 * Fire-and-forget — never blocks.
 */
export function broadcastPolicyCacheInvalidation(policyId: string): void {
  sql
    .notify("policy_cache_invalidate", JSON.stringify({ policy_id: policyId }))
    .catch((err) => {
      console.error("[pg-listen] Failed to broadcast policy_cache_invalidate NOTIFY", err);
    });
}
