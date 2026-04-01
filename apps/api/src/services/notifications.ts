/**
 * Notifications service — creates notifications and broadcasts via LISTEN/NOTIFY.
 * SSE subscriber management lives in pg-listeners.ts for cross-replica push.
 */

import { db } from "../db/client";
import { notifications } from "../db/schema/notifications";
import { eq, and, desc, sql } from "drizzle-orm";
import { broadcastNotification } from "./pg-listeners";

export interface CreateNotificationInput {
  workspaceId: string;
  type: string;
  title: string;
  body: string;
  linkUrl?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create a notification and broadcast it to all replicas via NOTIFY.
 * Fire-and-forget — never blocks the caller.
 */
export function createNotification(input: CreateNotificationInput): void {
  db.insert(notifications)
    .values({
      workspaceId: input.workspaceId,
      type: input.type,
      title: input.title,
      body: input.body,
      linkUrl: input.linkUrl ?? null,
      metadata: input.metadata ?? null,
    })
    .returning({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkUrl: notifications.linkUrl,
      createdAt: notifications.createdAt,
    })
    .then(([row]) => {
      if (!row) return;
      // Broadcast to all replicas via NOTIFY (including this one)
      broadcastNotification({
        workspaceId: input.workspaceId,
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        linkUrl: row.linkUrl,
        createdAt: row.createdAt,
      });
    })
    .catch(() => { /* fire-and-forget */ });
}

/**
 * Get notifications for a workspace (paginated, newest first).
 */
export async function getNotifications(
  workspaceId: string,
  options: { limit?: number; offset?: number; unreadOnly?: boolean } = {},
) {
  const { limit = 50, offset = 0, unreadOnly = false } = options;

  const conditions = [eq(notifications.workspaceId, workspaceId)];
  if (unreadOnly) {
    conditions.push(eq(notifications.read, false));
  }

  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkUrl: notifications.linkUrl,
      read: notifications.read,
      metadata: notifications.metadata,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Get unread notification count for a workspace.
 */
export async function getUnreadCount(workspaceId: string): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.read, false),
      ),
    );
  return result?.count ?? 0;
}

/**
 * Mark a single notification as read.
 */
export async function markAsRead(notificationId: string, workspaceId: string): Promise<boolean> {
  const result = await db
    .update(notifications)
    .set({ read: true })
    .where(
      and(
        eq(notifications.id, notificationId),
        eq(notifications.workspaceId, workspaceId),
      ),
    )
    .returning({ id: notifications.id });
  return result.length > 0;
}

/**
 * Mark all notifications as read for a workspace.
 */
export async function markAllAsRead(workspaceId: string): Promise<number> {
  const result = await db
    .update(notifications)
    .set({ read: true })
    .where(
      and(
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.read, false),
      ),
    )
    .returning({ id: notifications.id });
  return result.length;
}
