/**
 * Microsoft Teams / Graph API message utilities for Model B execution.
 * Extracts chat/channel IDs and message metadata from Graph API requests
 * for allowlist enforcement and human-readable approval display.
 */

/** Microsoft Teams message metadata extracted for approval display. */
export interface TeamsMessageMetadata {
  chatId?: string;
  channelId?: string;
  teamId?: string;
  contentType?: string;
  bodyPreview?: string;
}

/**
 * Check if a URL targets the Microsoft Graph API.
 */
export function isMicrosoftGraphUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

/**
 * Check if a Microsoft Graph URL targets a chat message send endpoint.
 * Matches: POST /v1.0/chats/{chatId}/messages or /v1.0/me/chats/{chatId}/messages
 */
export function isTeamsChatSendUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "graph.microsoft.com") return false;
    // /v1.0/chats/{id}/messages or /v1.0/me/chats/{id}/messages
    return /^\/v1\.0\/(me\/)?chats\/[^/]+\/messages\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Check if a Microsoft Graph URL targets a channel message send endpoint.
 * Matches: POST /v1.0/teams/{teamId}/channels/{channelId}/messages
 */
export function isTeamsChannelSendUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "graph.microsoft.com") return false;
    return /^\/v1\.0\/teams\/[^/]+\/channels\/[^/]+\/messages\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Extract chat ID from a Microsoft Graph chat endpoint URL.
 * Matches: /v1.0/chats/{chatId}/... or /v1.0/me/chats/{chatId}/...
 * Returns null if no chat ID can be extracted.
 */
export function extractTeamsChatId(url: string): string | null {
  try {
    const parsed = new URL(url);
    // /v1.0/chats/{chatId}/...
    const chatMatch = parsed.pathname.match(/^\/v1\.0\/(?:me\/)?chats\/([^/]+)/);
    return chatMatch ? chatMatch[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Extract channel ID and team ID from a Microsoft Graph channel endpoint URL.
 * Matches: /v1.0/teams/{teamId}/channels/{channelId}/...
 * Returns null if IDs cannot be extracted.
 */
export function extractTeamsChannelInfo(url: string): { teamId: string; channelId: string } | null {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)/);
    if (!match) return null;
    return { teamId: match[1]!, channelId: match[2]! };
  } catch {
    return null;
  }
}

/**
 * Parse a Microsoft Graph message send request body to extract metadata
 * for human-readable approval display.
 * Graph API message format: { body: { contentType: "html"|"text", content: "..." } }
 */
export function parseTeamsMessagePayload(
  requestBody: unknown,
): TeamsMessageMetadata | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const messageBody = body["body"] as { contentType?: string; content?: string } | undefined;

  if (!messageBody) return null;

  const metadata: TeamsMessageMetadata = {};

  if (typeof messageBody.contentType === "string") {
    metadata.contentType = messageBody.contentType;
  }

  if (typeof messageBody.content === "string") {
    let preview = messageBody.content;
    // Strip HTML tags if contentType is html
    if (metadata.contentType === "html") {
      preview = preview.replace(/<[^>]*>/g, "").trim();
    }
    // Truncate for preview
    metadata.bodyPreview = preview.length > 500
      ? preview.slice(0, 500) + "..."
      : preview;
  }

  return metadata;
}
