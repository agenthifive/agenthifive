import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { pushSubscriptions } from "../db/schema/push-subscriptions";

const expoToken = process.env["EXPO_ACCESS_TOKEN"];
const expo = new Expo(expoToken ? { accessToken: expoToken } : {});

/** Module-level logger — wired from server.ts via setPushNotificationLogger(). */
interface PushLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
const defaultLogger: PushLogger = {
  error: (...args: unknown[]) => console.error("[push-notif]", ...args),
  warn: (...args: unknown[]) => console.warn("[push-notif]", ...args),
};
let _logger: PushLogger = defaultLogger;
export function setPushNotificationLogger(logger: PushLogger): void {
  _logger = logger;
}

export interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Send push notifications to all registered devices for a workspace.
 * Fire-and-forget — never blocks the caller.
 */
export function sendPushNotificationsForWorkspace(
  workspaceId: string,
  notification: PushNotificationData,
): void {
  _sendAsync(workspaceId, notification).catch((err) => {
    _logger.error({ err, workspaceId }, "Failed to send push notifications");
  });
}

async function _sendAsync(
  workspaceId: string,
  notification: PushNotificationData,
): Promise<void> {
  const subs = await db
    .select({
      id: pushSubscriptions.id,
      expoPushToken: pushSubscriptions.expoPushToken,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.workspaceId, workspaceId));

  if (subs.length === 0) return;

  const messages: ExpoPushMessage[] = [];
  for (const sub of subs) {
    if (!Expo.isExpoPushToken(sub.expoPushToken)) {
      // Invalid token — clean up
      db.delete(pushSubscriptions)
        .where(eq(pushSubscriptions.id, sub.id))
        .then(() => {})
        .catch((err) => { _logger.warn({ err, subscriptionId: sub.id }, "Failed to clean up invalid push token"); });
      continue;
    }

    const msg: ExpoPushMessage = {
      to: sub.expoPushToken,
      sound: "default",
      title: notification.title,
      body: notification.body,
      channelId: "approvals",
      priority: "high",
    };
    if (notification.data) msg.data = notification.data;
    messages.push(msg);
  }

  if (messages.length === 0) return;

  const chunks = expo.chunkPushNotifications(messages);
  const invalidTokenIds: string[] = [];

  for (const chunk of chunks) {
    const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk);

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i]!;
      if (ticket.status === "error") {
        // DeviceNotRegistered means the token is no longer valid
        if (ticket.details?.error === "DeviceNotRegistered") {
          const sub = subs.find((s) => s.expoPushToken === (chunk[i] as ExpoPushMessage).to);
          if (sub) invalidTokenIds.push(sub.id);
        }
      }
    }
  }

  // Clean up invalid tokens
  for (const id of invalidTokenIds) {
    db.delete(pushSubscriptions)
      .where(eq(pushSubscriptions.id, id))
      .then(() => {})
      .catch((err) => { _logger.warn({ err, subscriptionId: id }, "Failed to clean up expired push subscription"); });
  }
}
