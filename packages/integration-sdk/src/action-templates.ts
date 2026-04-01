/**
 * Action template mapping: tool IDs → AgentHiFive action template IDs.
 *
 * When checking capabilities, an agent framework needs to map its internal tool
 * names (like "send" with channel="telegram") to AH5 action template IDs (like
 * "gmail-manage").
 */

/**
 * Static mapping: tool name + channel → action template ID.
 *
 * Format: "toolName:channel" → "action-template-id"
 */
export const TOOL_TO_ACTION_TEMPLATE: Record<string, string> = {
  // Gmail tools (read-only vs manage — separate OAuth scopes)
  "send:gmail": "gmail-manage",
  "read:gmail": "gmail-read",
  "compose:gmail": "gmail-manage",
  "draft:gmail": "gmail-manage",

  // Google Calendar tools
  "read:calendar": "calendar-read",
  "create:calendar": "calendar-manage",
  "update:calendar": "calendar-manage",
  "delete:calendar": "calendar-manage",

  // Google Drive tools
  "read:drive": "drive-read",
  "upload:drive": "drive-manage",
  "update:drive": "drive-manage",
  "delete:drive": "drive-manage",
  "share:drive": "drive-manage",

  // Microsoft Teams tools
  "send:teams": "teams-manage",
  "read:teams": "teams-read",
  "upload:teams": "teams-manage",
  "message:teams": "teams-manage",

  // Outlook tools
  "send:outlook": "outlook-manage",
  "read:outlook": "outlook-read",

  // Telegram tools (single action template — bot tokens are all-or-nothing)
  "send:telegram": "telegram",
  "read:telegram": "telegram",
  "message:telegram": "telegram",

  // Slack tools (single bot token — security tier controls permissions)
  "send:slack": "slack",
  "read:slack": "slack",
  "message:slack": "slack",

  // OpenAI LLM tools (single API key — security tier controls permissions)
  "chat:openai": "openai",
  "embeddings:openai": "openai",

  // Google Gemini LLM tools (single API key — security tier controls permissions)
  "chat:gemini": "gemini",
  "embeddings:gemini": "gemini",

  // Anthropic LLM tools
  "chat:anthropic": "anthropic-messages",
  "messages:anthropic": "anthropic-messages",
};

/**
 * Get the AH5 action template ID for a given tool operation.
 *
 * @param toolName - Tool operation name (e.g., "send", "read", "create")
 * @param channel - Channel/provider name (e.g., "gmail", "teams", "telegram")
 * @returns Action template ID or null if no mapping exists
 */
export function getActionTemplateId(toolName: string, channel?: string): string | null {
  if (!channel) {
    return null;
  }
  const key = `${toolName}:${channel}`;
  return TOOL_TO_ACTION_TEMPLATE[key] ?? null;
}

/**
 * Check if a tool operation requires AH5 capability checking.
 * Returns false for tools that don't have an action template mapping.
 */
export function requiresCapabilityCheck(toolName: string, channel?: string): boolean {
  if (!channel) {
    return false;
  }
  return getActionTemplateId(toolName, channel) !== null;
}
