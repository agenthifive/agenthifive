/**
 * Slack Web API message utilities for Model B execution.
 * Extracts channel/user metadata from requests, and filters
 * responses for channel/user allowlist enforcement.
 */

/** Slack chat.postMessage metadata extracted for approval display. */
export interface SlackMessageMetadata {
  channel: string;
  text?: string;
}

/**
 * Check if a URL targets the Slack Web API.
 * Slack API URLs look like: https://slack.com/api/method.name
 */
export function isSlackApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "slack.com" && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/** Slack read methods that return channel/message data (all POST-based). */
const SLACK_READ_METHODS = [
  "/api/conversations.history",
  "/api/conversations.replies",
  "/api/conversations.list",
  "/api/conversations.info",
  "/api/users.info",
  "/api/users.list",
  "/api/emoji.list",
  "/api/pins.list",
  "/api/team.info",
  "/api/auth.test",
];

/**
 * Check if a Slack API URL is a read method.
 */
export function isSlackReadMethod(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return SLACK_READ_METHODS.some((m) => path === m || path === `${m}/`);
  } catch {
    return false;
  }
}

/**
 * Check if a Slack API URL is conversations.list.
 */
export function isSlackConversationsListUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return path === "/api/conversations.list" || path === "/api/conversations.list/";
  } catch {
    return false;
  }
}

/**
 * Check if a Slack API URL is conversations.history or conversations.replies.
 */
export function isSlackConversationsHistoryUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname;
    return (
      path === "/api/conversations.history" || path === "/api/conversations.history/" ||
      path === "/api/conversations.replies" || path === "/api/conversations.replies/"
    );
  } catch {
    return false;
  }
}

/**
 * Extract the channel ID from a Slack API request body.
 * Most methods use `channel`, but files.uploadV2 uses `channel_id`.
 * Returns null if no channel can be extracted.
 */
export function extractSlackChannel(requestBody: unknown): string | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const channel = body["channel"] ?? body["channel_id"];

  if (channel === undefined || channel === null) return null;
  return String(channel);
}

/**
 * Filter a Slack conversations.list response to only include
 * allowed channel IDs. DM conversations (is_im: true) are also
 * kept if the other user is in allowedUserIds. Group DMs
 * (is_mpim: true) are kept when no user restrictions are set.
 * If both allowlists are empty, returns the body unchanged.
 */
export function filterSlackChannels(
  body: Record<string, unknown>,
  allowedChannelIds: string[],
  allowedUserIds: string[] = [],
): Record<string, unknown> {
  if (allowedChannelIds.length === 0 && allowedUserIds.length === 0) return body;
  if (!body["ok"] || !Array.isArray(body["channels"])) return body;

  const filtered = (body["channels"] as Record<string, unknown>[]).filter((channel) => {
    const id = channel["id"];
    if (id === undefined || id === null) return false;
    const idStr = String(id);

    // 1:1 DM conversations: keep if other user is in allowedUserIds (or no user restrictions)
    if (channel["is_im"] === true) {
      if (allowedUserIds.length === 0) return true;
      const user = channel["user"];
      return user !== undefined && user !== null && allowedUserIds.includes(String(user));
    }

    // Group DMs: keep when no user restrictions; otherwise let through
    // (group DMs don't have a single "user" field to check against)
    if (channel["is_mpim"] === true) {
      return true;
    }

    // Regular channels: check allowedChannelIds
    if (allowedChannelIds.length === 0) return true;
    return allowedChannelIds.includes(idStr);
  });

  return { ...body, channels: filtered };
}

/**
 * Filter a Slack conversations.history/replies response to only include
 * messages from allowed user IDs. Bot messages and system messages
 * (those without a "user" field) are always kept.
 * If allowedUserIds is empty, returns the body unchanged.
 */
export function filterSlackMessages(
  body: Record<string, unknown>,
  allowedUserIds: string[],
): Record<string, unknown> {
  if (allowedUserIds.length === 0) return body;
  if (!body["ok"] || !Array.isArray(body["messages"])) return body;

  const filtered = (body["messages"] as Record<string, unknown>[]).filter((msg) => {
    const user = msg["user"];
    // Keep bot messages / system messages (no user field)
    if (user === undefined || user === null) return true;
    // Keep messages where subtype is "bot_message"
    if (msg["subtype"] === "bot_message") return true;
    return allowedUserIds.includes(String(user));
  });

  return { ...body, messages: filtered };
}

/**
 * Parse a Slack chat.postMessage request body to extract metadata
 * for human-readable approval display.
 */
export function parseSlackSendPayload(
  requestBody: unknown,
): SlackMessageMetadata | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const channel = body["channel"] ?? body["channel_id"];

  if (channel === undefined || channel === null) return null;

  const metadata: SlackMessageMetadata = {
    channel: String(channel),
  };

  if (typeof body["text"] === "string") {
    // Truncate long messages for preview
    metadata.text = body["text"].length > 500
      ? body["text"].slice(0, 500) + "..."
      : body["text"];
  }

  return metadata;
}
