/**
 * Telegram Bot API message utilities for Model B execution.
 * Extracts chat_id and message metadata from sendMessage requests
 * for chat ID enforcement and human-readable approval display.
 */

/** Telegram sendMessage metadata extracted for approval display. */
export interface TelegramMessageMetadata {
  chatId: string;
  text?: string;
  parseMode?: string;
}

/**
 * Check if a URL targets the Telegram Bot API.
 * Telegram Bot API URLs look like: https://api.telegram.org/bot<token>/methodName
 */
export function isTelegramBotUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "api.telegram.org" && parsed.pathname.startsWith("/bot");
  } catch {
    return false;
  }
}

/**
 * Check if a Telegram Bot API URL targets the sendMessage method.
 */
export function isTelegramSendMessageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "api.telegram.org" &&
      parsed.pathname.endsWith("/sendMessage")
    );
  } catch {
    return false;
  }
}

/**
 * Extract the chat_id from a Telegram Bot API request body.
 * The chat_id can be a number or a string (e.g., "@channelusername").
 * Returns null if chat_id cannot be extracted.
 */
export function extractTelegramChatId(requestBody: unknown): string | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const chatId = body["chat_id"];

  if (chatId === undefined || chatId === null) return null;

  return String(chatId);
}

/**
 * Check if a Telegram Bot API URL targets the getUpdates method.
 */
export function isTelegramGetUpdatesUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "api.telegram.org" &&
      /\/bot[^/]*\/getUpdates$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Extract the chat ID from a single Telegram Update object.
 * Handles message, edited_message, channel_post, edited_channel_post,
 * callback_query, and my_chat_member update types.
 */
function extractChatIdFromUpdate(update: Record<string, unknown>): string | null {
  // Each update type has a different structure, but all contain a chat object
  for (const key of ["message", "edited_message", "channel_post", "edited_channel_post"]) {
    const msg = update[key] as Record<string, unknown> | undefined;
    const chat = msg?.["chat"] as Record<string, unknown> | undefined;
    if (chat?.["id"] != null) return String(chat["id"]);
  }
  // callback_query has message.chat
  const cbq = update["callback_query"] as Record<string, unknown> | undefined;
  const cbqMsg = cbq?.["message"] as Record<string, unknown> | undefined;
  const cbqChat = cbqMsg?.["chat"] as Record<string, unknown> | undefined;
  if (cbqChat?.["id"] != null) return String(cbqChat["id"]);
  // my_chat_member / chat_member
  for (const key of ["my_chat_member", "chat_member"]) {
    const member = update[key] as Record<string, unknown> | undefined;
    const chat = member?.["chat"] as Record<string, unknown> | undefined;
    if (chat?.["id"] != null) return String(chat["id"]);
  }
  return null;
}

/**
 * Filter a Telegram getUpdates response to only include updates from
 * allowed chat IDs. Returns the filtered response body.
 * If allowedChatIds is empty, returns the body unchanged (no restriction).
 */
export function filterTelegramUpdates(
  body: Record<string, unknown>,
  allowedChatIds: string[],
): Record<string, unknown> {
  if (allowedChatIds.length === 0) return body;
  if (!body["ok"] || !Array.isArray(body["result"])) return body;

  const filtered = (body["result"] as Record<string, unknown>[]).filter((update) => {
    const chatId = extractChatIdFromUpdate(update);
    // If we can't determine the chat ID, drop the update (safe default)
    if (!chatId) return false;
    return allowedChatIds.includes(chatId);
  });

  return { ...body, result: filtered };
}

/**
 * Parse a Telegram sendMessage request body to extract metadata
 * for human-readable approval display.
 */
export function parseTelegramSendPayload(
  requestBody: unknown,
): TelegramMessageMetadata | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const chatId = body["chat_id"];

  if (chatId === undefined || chatId === null) return null;

  const metadata: TelegramMessageMetadata = {
    chatId: String(chatId),
  };

  if (typeof body["text"] === "string") {
    // Truncate long messages for preview
    metadata.text = body["text"].length > 500
      ? body["text"].slice(0, 500) + "..."
      : body["text"];
  }

  if (typeof body["parse_mode"] === "string") {
    metadata.parseMode = body["parse_mode"];
  }

  return metadata;
}
