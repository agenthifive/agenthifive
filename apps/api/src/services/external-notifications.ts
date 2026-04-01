import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { notificationChannels } from "../db/schema/notification-channels";
import { connections } from "../db/schema/connections";
import { approvalRequests } from "../db/schema/approval-requests";
import { sendTelegramNotification, editTelegramMessage } from "./telegram-notifications";
import { sendSlackNotification } from "./slack-notifications";
import { sendPushNotificationsForWorkspace } from "./push-notifications";
import { Sentry } from "../instrument";

const WEB_URL = process.env["WEB_URL"] || process.env["NEXT_PUBLIC_WEB_URL"] || "https://app.agenthifive.com";

/** Module-level logger — wired from server.ts via setExternalNotificationLogger(). */
interface NotificationLogger {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
const defaultLogger: NotificationLogger = {
  error: (...args: unknown[]) => console.error("[ext-notif]", ...args),
  warn: (...args: unknown[]) => console.warn("[ext-notif]", ...args),
};
let _logger: NotificationLogger = defaultLogger;
export function setExternalNotificationLogger(logger: NotificationLogger): void {
  _logger = logger;
}

export interface ApprovalNotificationData {
  workspaceId: string;
  approvalId: string;
  agentName: string;
  method: string;
  url: string;
  quickActionToken: string;
  expiresAt: Date;
  ruleLabel?: string | undefined;
}

/**
 * Send approval notification to all configured external channels.
 * Fire-and-forget — never blocks the caller.
 */
export function sendApprovalNotifications(data: ApprovalNotificationData): void {
  _sendAsync(data).catch((err) => {
    _logger.error({ err, approvalId: data.approvalId }, "Failed to send approval notifications");
    Sentry.captureException(err, { tags: { source: "sendApprovalNotifications" } });
  });
}

async function _sendAsync(data: ApprovalNotificationData): Promise<void> {
  const channels = await db
    .select({
      id: notificationChannels.id,
      channelType: notificationChannels.channelType,
      connectionId: notificationChannels.connectionId,
      config: notificationChannels.config,
    })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, data.workspaceId),
        eq(notificationChannels.enabled, true),
        eq(notificationChannels.verificationStatus, "verified"),
      ),
    );

  for (const channel of channels) {
    if (channel.channelType === "telegram" && channel.connectionId) {
      await _sendTelegramApproval(channel, data).catch((err) => {
        _logger.warn({ err, channelId: channel.id }, "Telegram approval notification failed");
      });
    } else if (channel.channelType === "slack" && channel.connectionId) {
      await _sendSlackApproval(channel, data).catch((err) => {
        _logger.warn({ err, channelId: channel.id }, "Slack approval notification failed");
      });
    }
  }

  // Mobile push notifications — send to all registered devices for this workspace
  let urlDisplay: string;
  try {
    const parsed = new URL(data.url);
    urlDisplay = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    urlDisplay = data.url;
  }

  sendPushNotificationsForWorkspace(data.workspaceId, {
    title: "Approval Required",
    body: `${data.agentName} wants to ${data.method} ${truncate(urlDisplay, 80)}`,
    data: {
      type: "approval_request",
      approvalId: data.approvalId,
      url: "/dashboard/approvals",
    },
  });
}

async function _sendTelegramApproval(
  channel: { connectionId: string | null; config: unknown },
  data: ApprovalNotificationData,
): Promise<void> {
  if (!channel.connectionId) return;

  const config = channel.config as { chatId?: string };
  if (!config.chatId) return;

  const [conn] = await db
    .select({ encryptedTokens: connections.encryptedTokens })
    .from(connections)
    .where(eq(connections.id, channel.connectionId))
    .limit(1);
  if (!conn?.encryptedTokens) return;

  const approveUrl = `${WEB_URL}/api/quick-action/${data.quickActionToken}/approve`;
  const denyUrl = `${WEB_URL}/api/quick-action/${data.quickActionToken}/deny`;

  const expiresInSec = Math.max(0, Math.floor((data.expiresAt.getTime() - Date.now()) / 1000));
  const expiresInMin = Math.ceil(expiresInSec / 60);

  let urlDisplay: string;
  try {
    const parsed = new URL(data.url);
    urlDisplay = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    urlDisplay = data.url;
  }

  let text = `<b>Approval Required</b>\n\n`;
  text += `<b>${escapeHtml(data.agentName)}</b> wants to:\n`;
  text += `<code>${escapeHtml(data.method)} ${escapeHtml(truncate(urlDisplay, 80))}</code>\n`;
  if (data.ruleLabel) {
    text += `Rule: <i>${escapeHtml(data.ruleLabel)}</i>\n`;
  }
  text += `\nExpires in ${expiresInMin} minute${expiresInMin !== 1 ? "s" : ""}`;

  const result = await sendTelegramNotification(conn.encryptedTokens, {
    chatId: config.chatId,
    text,
    parseMode: "HTML",
    replyMarkup: {
      inline_keyboard: [[
        { text: "Approve", url: approveUrl },
        { text: "Deny", url: denyUrl },
      ]],
    },
  });

  // Store message_id so we can edit the message after resolution
  if (result.ok && result.messageId) {
    db.update(approvalRequests)
      .set({ telegramMessageId: result.messageId, telegramChatId: config.chatId })
      .where(eq(approvalRequests.id, data.approvalId))
      .catch((err: unknown) => { _logger.warn({ err, approvalId: data.approvalId }, "Failed to store Telegram message ID"); });
  }
}

async function _sendSlackApproval(
  channel: { connectionId: string | null; config: unknown },
  data: ApprovalNotificationData,
): Promise<void> {
  if (!channel.connectionId) return;

  const config = channel.config as { channelId?: string };
  if (!config.channelId) return;

  const [conn] = await db
    .select({ encryptedTokens: connections.encryptedTokens })
    .from(connections)
    .where(eq(connections.id, channel.connectionId))
    .limit(1);
  if (!conn?.encryptedTokens) return;

  const approveUrl = `${WEB_URL}/api/quick-action/${data.quickActionToken}/approve`;
  const denyUrl = `${WEB_URL}/api/quick-action/${data.quickActionToken}/deny`;

  const expiresInSec = Math.max(0, Math.floor((data.expiresAt.getTime() - Date.now()) / 1000));
  const expiresInMin = Math.ceil(expiresInSec / 60);

  let urlDisplay: string;
  try {
    const parsed = new URL(data.url);
    urlDisplay = `${parsed.hostname}${parsed.pathname}`;
  } catch {
    urlDisplay = data.url;
  }

  let text = `*Approval Required*\n\n`;
  text += `*${escapeSlackMrkdwn(data.agentName)}* wants to:\n`;
  text += `\`${escapeSlackMrkdwn(data.method)} ${escapeSlackMrkdwn(truncate(urlDisplay, 80))}\`\n`;
  if (data.ruleLabel) {
    text += `Rule: _${escapeSlackMrkdwn(data.ruleLabel)}_\n`;
  }
  text += `\nExpires in ${expiresInMin} minute${expiresInMin !== 1 ? "s" : ""}`;

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          url: approveUrl,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          url: denyUrl,
        },
      ],
    },
  ];

  await sendSlackNotification(conn.encryptedTokens, {
    channel: config.channelId,
    text: `Approval Required: ${data.agentName} wants to ${data.method} ${truncate(urlDisplay, 60)}`,
    blocks,
  });
}

function escapeSlackMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Edit the Telegram approval notification message to show the resolution outcome.
 * Call this fire-and-forget after an approval is approved or denied.
 */
export function editTelegramApprovalMessage(
  approvalId: string,
  status: "approved" | "denied" | "expired",
): void {
  _editTelegramApprovalAsync(approvalId, status).catch((err) => {
    _logger.warn({ err, approvalId }, "Failed to edit Telegram approval message");
  });
}

// ── Security alert notifications ─────────────────────────────────

export interface SecurityAlertData {
  workspaceId: string;
  agentName: string;
  alertTitle: string;
  alertBody: string;
}

/**
 * Send security alert to all configured external channels.
 * Fire-and-forget — never blocks the caller.
 */
export function sendSecurityAlertNotifications(data: SecurityAlertData): void {
  _sendSecurityAlertAsync(data).catch((err) => {
    _logger.error({ err, workspaceId: data.workspaceId }, "Failed to send security alert notifications");
    Sentry.captureException(err, { tags: { source: "sendSecurityAlertNotifications" } });
  });
}

async function _sendSecurityAlertAsync(data: SecurityAlertData): Promise<void> {
  const channels = await db
    .select({
      id: notificationChannels.id,
      channelType: notificationChannels.channelType,
      connectionId: notificationChannels.connectionId,
      config: notificationChannels.config,
    })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, data.workspaceId),
        eq(notificationChannels.enabled, true),
        eq(notificationChannels.verificationStatus, "verified"),
      ),
    );

  for (const channel of channels) {
    if (channel.channelType === "telegram" && channel.connectionId) {
      await _sendTelegramSecurityAlert(channel, data).catch((err) => {
        _logger.warn({ err, channelId: channel.id }, "Telegram security alert notification failed");
      });
    } else if (channel.channelType === "slack" && channel.connectionId) {
      await _sendSlackSecurityAlert(channel, data).catch((err) => {
        _logger.warn({ err, channelId: channel.id }, "Slack security alert notification failed");
      });
    }
  }

  // Mobile push
  sendPushNotificationsForWorkspace(data.workspaceId, {
    title: `⚠️ Security Alert`,
    body: `${data.agentName}: ${data.alertTitle}`,
    data: {
      type: "security_alert",
      url: "/dashboard/activity",
    },
  });
}

async function _sendTelegramSecurityAlert(
  channel: { connectionId: string | null; config: unknown },
  data: SecurityAlertData,
): Promise<void> {
  if (!channel.connectionId) return;
  const config = channel.config as { chatId?: string };
  if (!config.chatId) return;

  const [conn] = await db
    .select({ encryptedTokens: connections.encryptedTokens })
    .from(connections)
    .where(eq(connections.id, channel.connectionId))
    .limit(1);
  if (!conn?.encryptedTokens) return;

  let text = `<b>⚠️ Security Alert</b>\n\n`;
  text += `<b>${escapeHtml(data.alertTitle)}</b>\n\n`;
  text += `${escapeHtml(data.alertBody)}\n\n`;
  text += `<a href="${WEB_URL}/dashboard/activity">View Activity Log</a>`;

  await sendTelegramNotification(conn.encryptedTokens, {
    chatId: config.chatId,
    text,
    parseMode: "HTML",
  });
}

async function _sendSlackSecurityAlert(
  channel: { connectionId: string | null; config: unknown },
  data: SecurityAlertData,
): Promise<void> {
  if (!channel.connectionId) return;
  const config = channel.config as { channelId?: string };
  if (!config.channelId) return;

  const [conn] = await db
    .select({ encryptedTokens: connections.encryptedTokens })
    .from(connections)
    .where(eq(connections.id, channel.connectionId))
    .limit(1);
  if (!conn?.encryptedTokens) return;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*⚠️ Security Alert*\n\n*${escapeSlackMrkdwn(data.alertTitle)}*\n\n${escapeSlackMrkdwn(data.alertBody)}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Activity" },
          url: `${WEB_URL}/dashboard/activity`,
        },
      ],
    },
  ];

  await sendSlackNotification(conn.encryptedTokens, {
    channel: config.channelId,
    text: `⚠️ Security Alert: ${data.agentName} — ${data.alertTitle}`,
    blocks,
  });
}

// ── Approval message editing ─────────────────────────────────────

async function _editTelegramApprovalAsync(
  approvalId: string,
  status: "approved" | "denied" | "expired",
): Promise<void> {
  // Fetch the stored message coordinates and workspace
  const [approval] = await db
    .select({
      telegramMessageId: approvalRequests.telegramMessageId,
      telegramChatId: approvalRequests.telegramChatId,
      workspaceId: approvalRequests.workspaceId,
    })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId))
    .limit(1);

  if (!approval?.telegramMessageId || !approval.telegramChatId) return;

  // Find the telegram notification channel for this workspace
  const [channel] = await db
    .select({ connectionId: notificationChannels.connectionId })
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.workspaceId, approval.workspaceId),
        eq(notificationChannels.channelType, "telegram"),
        eq(notificationChannels.enabled, true),
        eq(notificationChannels.verificationStatus, "verified"),
      ),
    )
    .limit(1);

  if (!channel?.connectionId) return;

  const [conn] = await db
    .select({ encryptedTokens: connections.encryptedTokens })
    .from(connections)
    .where(eq(connections.id, channel.connectionId))
    .limit(1);

  if (!conn?.encryptedTokens) return;

  const statusText = status === "approved" ? "✅ Approved" : status === "denied" ? "❌ Denied" : "⏰ Expired";
  await editTelegramMessage(conn.encryptedTokens, {
    chatId: approval.telegramChatId,
    messageId: approval.telegramMessageId,
    text: statusText,
    replyMarkup: { inline_keyboard: [] },
  });
}
