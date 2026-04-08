/**
 * Policy generation from templates
 * Converts policy templates into actual policy configurations
 */

import {
  type PolicyTier,
  getPolicyTemplate,
  getPresetsForActionTemplate,
  CONTEXTUAL_GUARDS,
  type AllowlistEntry,
  type RateLimit,
  type TimeWindow,
  type PolicyRules,
  type RequestRule,
  type ResponseRule,
} from "@agenthifive/contracts";

interface PolicyTemplateData {
  actionTemplateId: string;
  tier: PolicyTier;
  allowlists: AllowlistEntry[];
  rateLimits: RateLimit;
  timeWindows: TimeWindow[];
  rules: PolicyRules;
  stepUpApproval: "always" | "risk_based" | "never";
}

// ── Provider resolution ──────────────────────────────────────────────

/**
 * Maps action template ID prefix to provider name.
 * The prefix is everything before the first hyphen (or the whole string).
 */
const ACTION_PREFIX_TO_PROVIDER: Record<string, string> = {
  gmail: "google",
  calendar: "google",
  drive: "google",
  docs: "google",
  sheets: "google",
  contacts: "google",
  teams: "microsoft",
  outlook: "microsoft",
  onedrive: "microsoft",
  telegram: "telegram",
  slack: "slack",
  anthropic: "anthropic",
  openai: "openai",
  gemini: "gemini",
  openrouter: "openrouter",
  notion: "notion",
  trello: "trello",
  jira: "jira",
};

function resolveProvider(actionTemplateId: string): string {
  const hyphen = actionTemplateId.indexOf("-");
  const prefix = hyphen === -1 ? actionTemplateId : actionTemplateId.slice(0, hyphen);
  return ACTION_PREFIX_TO_PROVIDER[prefix] ?? "unknown";
}

/** LLM providers get no time windows, no step-up approval — guards handle risk. */
const LLM_PROVIDER_SET = new Set(["anthropic", "openai", "gemini", "openrouter"]);

// ── Time window parsing ──────────────────────────────────────────────

/**
 * Parse time window description into TimeWindow objects
 * Handles common patterns like:
 * - "Monday-Friday: 9:00 AM - 5:00 PM (Business hours only)"
 * - "Monday-Sunday: 6:00 AM - 10:00 PM (Extended hours)"
 * - "24/7 access enabled"
 */
function parseTimeWindows(description: string, timezone = "UTC"): TimeWindow[] {
  // Handle 24/7 case
  if (description.includes("24/7")) {
    return [
      { dayOfWeek: 0, startHour: 0, endHour: 23, timezone }, // Sunday
      { dayOfWeek: 1, startHour: 0, endHour: 23, timezone }, // Monday
      { dayOfWeek: 2, startHour: 0, endHour: 23, timezone }, // Tuesday
      { dayOfWeek: 3, startHour: 0, endHour: 23, timezone }, // Wednesday
      { dayOfWeek: 4, startHour: 0, endHour: 23, timezone }, // Thursday
      { dayOfWeek: 5, startHour: 0, endHour: 23, timezone }, // Friday
      { dayOfWeek: 6, startHour: 0, endHour: 23, timezone }, // Saturday
    ];
  }

  // Parse "Monday-Friday: 9:00 AM - 5:00 PM" pattern
  const dayRangeMatch = description.match(/(Monday|Sunday)-(Friday|Sunday)/);
  const timeMatch = description.match(/(\d+):(\d+)\s*(AM|PM)?\s*-\s*(\d+):(\d+)\s*(AM|PM)?/);

  if (!dayRangeMatch || !timeMatch) {
    // Fallback to business hours
    return [
      { dayOfWeek: 1, startHour: 9, endHour: 17, timezone }, // Monday
      { dayOfWeek: 2, startHour: 9, endHour: 17, timezone }, // Tuesday
      { dayOfWeek: 3, startHour: 9, endHour: 17, timezone }, // Wednesday
      { dayOfWeek: 4, startHour: 9, endHour: 17, timezone }, // Thursday
      { dayOfWeek: 5, startHour: 9, endHour: 17, timezone }, // Friday
    ];
  }

  const startDay = dayRangeMatch[1] === "Monday" ? 1 : 0;
  const endDay = dayRangeMatch[2] === "Friday" ? 5 : dayRangeMatch[2] === "Sunday" ? 6 : 0;

  // Parse hours (convert to 24-hour format)
  let startHour = Number.parseInt(timeMatch[1] || "9");
  const startMinute = Number.parseInt(timeMatch[2] || "0");
  const startPeriod = timeMatch[3] || "AM";

  let endHour = Number.parseInt(timeMatch[4] || "17");
  const endMinute = Number.parseInt(timeMatch[5] || "0");
  const endPeriod = timeMatch[6] || "PM";

  // Convert to 24-hour format
  if (startPeriod === "PM" && startHour !== 12) startHour += 12;
  if (startPeriod === "AM" && startHour === 12) startHour = 0;
  if (endPeriod === "PM" && endHour !== 12) endHour += 12;
  if (endPeriod === "AM" && endHour === 12) endHour = 0;

  // Create time windows for each day in range
  const windows: TimeWindow[] = [];

  // Handle Monday-Sunday case (need to include Sunday = day 0)
  if (startDay === 1 && endDay === 6) {
    // Monday through Saturday
    for (let day = 1; day <= 6; day++) {
      windows.push({
        dayOfWeek: day,
        startHour,
        endHour,
        timezone,
      });
    }
    // Add Sunday (day 0)
    windows.push({
      dayOfWeek: 0,
      startHour,
      endHour,
      timezone,
    });
  } else {
    // Normal range (e.g., Monday-Friday)
    for (let day = startDay; day <= endDay; day++) {
      windows.push({
        dayOfWeek: day,
        startHour,
        endHour,
        timezone,
      });
    }
  }

  return windows;
}

// ── Allowlists ───────────────────────────────────────────────────────

/**
 * Get allowlists for an action template.
 * Each action template has tiered allowlists (strict → minimal).
 */
function getAllowlistsForAction(actionTemplateId: string, tier: PolicyTier): AllowlistEntry[] {
  const allowlistMap: Record<string, Record<PolicyTier, AllowlistEntry[]>> = {
    // ── Google Gmail ──
    // Gmail nests sub-resources (e.g. /messages/{id}/attachments/{aid}), so use **
    "gmail-read": {
      strict: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET"], pathPatterns: ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/**", "/gmail/v1/users/me/labels"] }],
      standard: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET"], pathPatterns: ["/gmail/v1/users/me/messages/**", "/gmail/v1/users/me/threads/**"] }],
      minimal: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET"], pathPatterns: ["/gmail/v1/users/me/**"] }],
    },
    "gmail-manage": {
      strict: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/**", "/gmail/v1/users/me/drafts", "/gmail/v1/users/me/labels", "/gmail/v1/users/me/messages/send"] }],
      standard: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/gmail/v1/users/me/messages/**", "/gmail/v1/users/me/threads/**", "/gmail/v1/users/me/drafts/**", "/gmail/v1/users/me/labels/**", "/gmail/v1/users/me/messages/send"] }],
      minimal: [{ baseUrl: "https://gmail.googleapis.com", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/gmail/v1/users/me/**"] }],
    },

    // ── Google Calendar ──
    "calendar-read": {
      strict: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/calendar/v3/calendars/*/events", "/calendar/v3/users/me/calendarList"] }],
      standard: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/calendar/v3/calendars/**", "/calendar/v3/users/me/calendarList"] }],
      minimal: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/calendar/v3/**"] }],
    },
    "calendar-manage": {
      strict: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/calendar/v3/calendars/*/events", "/calendar/v3/calendars/*/events/**", "/calendar/v3/users/me/calendarList"] }],
      standard: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/calendar/v3/calendars/**", "/calendar/v3/users/me/calendarList"] }],
      minimal: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/calendar/v3/**"] }],
    },

    // ── Google Drive ──
    "drive-read": {
      strict: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/drive/v3/files", "/drive/v3/files/**"] }],
      standard: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/drive/v3/files", "/drive/v3/files/**", "/drive/v3/about"] }],
      minimal: [{ baseUrl: "https://www.googleapis.com", methods: ["GET"], pathPatterns: ["/drive/v3/**"] }],
    },
    "drive-manage": {
      strict: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/drive/v3/files", "/drive/v3/files/**", "/upload/drive/v3/files", "/upload/drive/v3/files/**"] }],
      standard: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/drive/v3/files", "/drive/v3/files/**", "/drive/v3/files/*/permissions", "/upload/drive/v3/files", "/upload/drive/v3/files/**"] }],
      minimal: [{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/drive/v3/**", "/upload/drive/v3/**"] }],
    },

    // ── Google Docs ──
    "docs-read": {
      strict: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/documents/*"] }],
      standard: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/documents/*"] }],
      minimal: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/documents/*"] }],
    },
    "docs-manage": {
      strict: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/v1/documents/*", "/v1/documents/*:batchUpdate"] }],
      standard: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/v1/documents", "/v1/documents/*", "/v1/documents/*:batchUpdate"] }],
      minimal: [{ baseUrl: "https://docs.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/v1/documents/**"] }],
    },

    // ── Google Sheets ──
    "sheets-read": {
      strict: [{ baseUrl: "https://sheets.googleapis.com", methods: ["GET"], pathPatterns: ["/v4/spreadsheets/*", "/v4/spreadsheets/*/values/*"] }],
      standard: [{ baseUrl: "https://sheets.googleapis.com", methods: ["GET"], pathPatterns: ["/v4/spreadsheets/*", "/v4/spreadsheets/*/values/*", "/v4/spreadsheets/*/values:batchGet"] }],
      minimal: [{ baseUrl: "https://sheets.googleapis.com", methods: ["GET"], pathPatterns: ["/v4/spreadsheets/**"] }],
    },
    "sheets-manage": {
      strict: [
        { baseUrl: "https://sheets.googleapis.com", methods: ["GET"], pathPatterns: ["/v4/spreadsheets/*", "/v4/spreadsheets/*/values/*"] },
        { baseUrl: "https://sheets.googleapis.com", methods: ["PUT"], pathPatterns: ["/v4/spreadsheets/*/values/*"] },
      ],
      standard: [
        { baseUrl: "https://sheets.googleapis.com", methods: ["GET"], pathPatterns: ["/v4/spreadsheets/*", "/v4/spreadsheets/*/values/*", "/v4/spreadsheets/*/values:batchGet"] },
        { baseUrl: "https://sheets.googleapis.com", methods: ["PUT", "POST"], pathPatterns: ["/v4/spreadsheets/*/values/*", "/v4/spreadsheets", "/v4/spreadsheets/*:batchUpdate", "/v4/spreadsheets/*/values/*:append"] },
      ],
      minimal: [{ baseUrl: "https://sheets.googleapis.com", methods: ["GET", "POST", "PUT"], pathPatterns: ["/v4/spreadsheets/**"] }],
    },

    // ── Microsoft Teams ──
    "teams-read": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/teams/*/channels/*/messages", "/v1.0/me/chats/*/messages"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/teams/**", "/v1.0/me/chats/**", "/v1.0/me/joinedTeams"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/teams/**", "/v1.0/me/**"] }],
    },
    "teams-manage": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST"], pathPatterns: ["/v1.0/teams/*/channels/*/messages", "/v1.0/me/chats/*/messages", "/v1.0/me/joinedTeams"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/teams/**", "/v1.0/me/chats/**", "/v1.0/me/joinedTeams"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/teams/**", "/v1.0/me/**"] }],
    },

    // ── Microsoft Outlook ──
    "outlook-read": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/messages", "/v1.0/me/messages/**"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/messages/**", "/v1.0/me/mailFolders/**"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/messages/**", "/v1.0/me/mailFolders/**", "/v1.0/me"] }],
    },
    "outlook-manage": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/messages/**", "/v1.0/me/mailFolders/**", "/v1.0/me/sendMail"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/messages/**", "/v1.0/me/mailFolders/**", "/v1.0/me/sendMail"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/**"] }],
    },

    // ── Microsoft Outlook Calendar ──
    "outlook-calendar-read": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/events", "/v1.0/me/events/**", "/v1.0/me/calendar/events", "/v1.0/me/calendar/events/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendar/calendarView"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/events/**", "/v1.0/me/calendar/events/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendar/calendarView", "/v1.0/me/calendarGroups/**"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/events/**", "/v1.0/me/calendar/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendarGroups/**"] }],
    },
    "outlook-calendar-manage": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/events", "/v1.0/me/events/**", "/v1.0/me/calendar/events", "/v1.0/me/calendar/events/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendar/calendarView"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/events/**", "/v1.0/me/calendar/events/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendar/calendarView", "/v1.0/me/calendarGroups/**"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/events/**", "/v1.0/me/calendar/**", "/v1.0/me/calendars/**", "/v1.0/me/calendarView", "/v1.0/me/calendarGroups/**"] }],
    },

    // ── Google Contacts ──
    // Google People API uses resource:method RPC syntax (e.g. /v1/people:createContact,
    // /v1/people:searchContacts). These don't match /** globs, so add :* patterns.
    "contacts-read": {
      strict: [{ baseUrl: "https://people.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/people/me/connections", "/v1/people/**", "/v1/people:*", "/v1/contactGroups", "/v1/contactGroups:*"] }],
      standard: [{ baseUrl: "https://people.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/people/**", "/v1/people:*", "/v1/contactGroups/**", "/v1/contactGroups:*", "/v1/otherContacts/**", "/v1/otherContacts:*"] }],
      minimal: [{ baseUrl: "https://people.googleapis.com", methods: ["GET"], pathPatterns: ["/v1/**"] }],
    },
    "contacts-manage": {
      strict: [{ baseUrl: "https://people.googleapis.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1/people/me/connections", "/v1/people/**", "/v1/people:*", "/v1/contactGroups", "/v1/contactGroups:*"] }],
      standard: [{ baseUrl: "https://people.googleapis.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1/people/**", "/v1/people:*", "/v1/contactGroups/**", "/v1/contactGroups:*"] }],
      minimal: [{ baseUrl: "https://people.googleapis.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1/**"] }],
    },

    // ── Microsoft Outlook Contacts ──
    "outlook-contacts-read": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/contacts", "/v1.0/me/contacts/**"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/contacts/**", "/v1.0/me/contactFolders/**", "/v1.0/me/people"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/contacts/**", "/v1.0/me/contactFolders/**", "/v1.0/me/people", "/v1.0/me"] }],
    },
    "outlook-contacts-manage": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH"], pathPatterns: ["/v1.0/me/contacts", "/v1.0/me/contacts/**"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/contacts/**", "/v1.0/me/contactFolders/*/contacts"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/contacts/**", "/v1.0/me/contactFolders/**"] }],
    },

    // ── Microsoft OneDrive ──
    "onedrive-read": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/drive/root/children", "/v1.0/me/drive/root/children/**", "/v1.0/me/drive/items/**", "/v1.0/me/drive/root:/**"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/drive/**", "/v1.0/drives/**"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET"], pathPatterns: ["/v1.0/me/drive/**", "/v1.0/drives/**", "/v1.0/me"] }],
    },
    "onedrive-manage": {
      strict: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/drive/root/children", "/v1.0/me/drive/root/children/**", "/v1.0/me/drive/items/**", "/v1.0/me/drive/root:/**"] }],
      standard: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/drive/**", "/v1.0/drives/**"] }],
      minimal: [{ baseUrl: "https://graph.microsoft.com", methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], pathPatterns: ["/v1.0/me/drive/**", "/v1.0/drives/**", "/v1.0/me"] }],
    },

    // ── Telegram ──
    "telegram": {
      strict: [{ baseUrl: "https://api.telegram.org", methods: ["POST"], pathPatterns: ["/bot*/sendMessage", "/bot*/getUpdates", "/bot*/getMe"] }],
      standard: [{ baseUrl: "https://api.telegram.org", methods: ["GET", "POST"], pathPatterns: ["/bot*/sendMessage", "/bot*/sendPhoto", "/bot*/sendDocument", "/bot*/getUpdates", "/bot*/getMe", "/bot*/getChat", "/bot*/getChatMember"] }],
      minimal: [{ baseUrl: "https://api.telegram.org", methods: ["GET", "POST"], pathPatterns: ["/bot*/*"] }],
    },

    // ── Slack (single bot token — one template covers read + write) ──
    "slack": {
      strict: [{ baseUrl: "https://slack.com", methods: ["POST"], pathPatterns: ["/api/conversations.list", "/api/conversations.history", "/api/conversations.info", "/api/chat.postMessage"] }],
      standard: [{ baseUrl: "https://slack.com", methods: ["POST"], pathPatterns: ["/api/conversations.*", "/api/users.*", "/api/chat.postMessage", "/api/chat.update", "/api/files.uploadV2", "/api/reactions.add"] }],
      minimal: [{ baseUrl: "https://slack.com", methods: ["POST"], pathPatterns: ["/api/*"] }],
    },

    // ── Notion ──
    "notion-read": {
      strict: [
        { baseUrl: "https://api.notion.com", methods: ["GET"], pathPatterns: ["/v1/pages/*", "/v1/databases/*", "/v1/blocks/*", "/v1/blocks/*/children"] },
        { baseUrl: "https://api.notion.com", methods: ["POST"], pathPatterns: ["/v1/databases/*/query", "/v1/search"] },
      ],
      standard: [
        { baseUrl: "https://api.notion.com", methods: ["GET"], pathPatterns: ["/v1/pages/*", "/v1/pages/*/properties/*", "/v1/databases/*", "/v1/blocks/*", "/v1/blocks/*/children"] },
        { baseUrl: "https://api.notion.com", methods: ["POST"], pathPatterns: ["/v1/databases/*/query", "/v1/search"] },
      ],
      minimal: [{ baseUrl: "https://api.notion.com", methods: ["GET", "POST"], pathPatterns: ["/v1/**"] }],
    },
    "notion-manage": {
      strict: [
        { baseUrl: "https://api.notion.com", methods: ["GET"], pathPatterns: ["/v1/pages/*", "/v1/databases/*", "/v1/blocks/*"] },
        { baseUrl: "https://api.notion.com", methods: ["POST"], pathPatterns: ["/v1/pages", "/v1/databases/*/query", "/v1/search"] },
        { baseUrl: "https://api.notion.com", methods: ["PATCH"], pathPatterns: ["/v1/pages/*", "/v1/blocks/*"] },
      ],
      standard: [
        { baseUrl: "https://api.notion.com", methods: ["GET"], pathPatterns: ["/v1/pages/*", "/v1/pages/*/properties/*", "/v1/databases/*", "/v1/blocks/*", "/v1/blocks/*/children"] },
        { baseUrl: "https://api.notion.com", methods: ["POST"], pathPatterns: ["/v1/pages", "/v1/databases/*/query", "/v1/search", "/v1/comments"] },
        { baseUrl: "https://api.notion.com", methods: ["PATCH"], pathPatterns: ["/v1/pages/*", "/v1/blocks/*", "/v1/blocks/*/children"] },
        { baseUrl: "https://api.notion.com", methods: ["DELETE"], pathPatterns: ["/v1/blocks/*"] },
      ],
      minimal: [{ baseUrl: "https://api.notion.com", methods: ["GET", "POST", "PATCH", "DELETE"], pathPatterns: ["/v1/**"] }],
    },

    // ── Anthropic ──
    "anthropic-messages": {
      strict: [{ baseUrl: "https://api.anthropic.com", methods: ["GET", "POST"], pathPatterns: ["/v1/models", "/v1/messages"] }],
      standard: [{ baseUrl: "https://api.anthropic.com", methods: ["GET", "POST"], pathPatterns: ["/v1/models", "/v1/models/*", "/v1/messages"] }],
      minimal: [{ baseUrl: "https://api.anthropic.com", methods: ["GET", "POST"], pathPatterns: ["/v1/*"] }],
    },

    // ── OpenAI ──
    "openai": {
      strict: [{ baseUrl: "https://api.openai.com", methods: ["GET", "POST"], pathPatterns: ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/embeddings"] }],
      standard: [{ baseUrl: "https://api.openai.com", methods: ["GET", "POST"], pathPatterns: ["/v1/models", "/v1/models/*", "/v1/chat/completions", "/v1/responses", "/v1/embeddings"] }],
      minimal: [{ baseUrl: "https://api.openai.com", methods: ["GET", "POST"], pathPatterns: ["/v1/*"] }],
    },

    // ── Gemini ──
    "gemini": {
      strict: [{ baseUrl: "https://generativelanguage.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/v1beta/models", "/v1beta/models/*:generateContent", "/v1beta/models/*:embedContent"] }],
      standard: [{ baseUrl: "https://generativelanguage.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/v1beta/models", "/v1beta/models/*", "/v1beta/models/*:generateContent", "/v1beta/models/*:streamGenerateContent", "/v1beta/models/*:embedContent", "/v1beta/models/*:batchEmbedContents"] }],
      minimal: [{
        baseUrl: "https://generativelanguage.googleapis.com",
        methods: ["GET", "POST"],
        pathPatterns: [
          "/v1beta/models",
          "/v1beta/models/*",
          "/v1beta/models/*:generateContent",
          "/v1beta/models/*:streamGenerateContent",
          "/v1beta/models/*:embedContent",
          "/v1beta/models/*:batchEmbedContents",
        ],
      }],
    },

    // ── OpenRouter ──
    "openrouter": {
      strict: [{ baseUrl: "https://openrouter.ai", methods: ["GET", "POST"], pathPatterns: ["/api/v1/models", "/api/v1/chat/completions"] }],
      standard: [{ baseUrl: "https://openrouter.ai", methods: ["GET", "POST"], pathPatterns: ["/api/v1/models", "/api/v1/models/*", "/api/v1/chat/completions"] }],
      minimal: [{ baseUrl: "https://openrouter.ai", methods: ["GET", "POST"], pathPatterns: ["/api/v1/*"] }],
    },

    // ── Trello ──
    "trello-read": {
      strict: [{ baseUrl: "https://api.trello.com", methods: ["GET"], pathPatterns: ["/1/members/me/boards", "/1/boards/*", "/1/boards/*/lists", "/1/boards/*/cards"] }],
      standard: [{ baseUrl: "https://api.trello.com", methods: ["GET"], pathPatterns: ["/1/members/**", "/1/boards/**", "/1/lists/**", "/1/cards/**"] }],
      minimal: [{ baseUrl: "https://api.trello.com", methods: ["GET"], pathPatterns: ["/1/**"] }],
    },
    "trello-manage": {
      strict: [
        { baseUrl: "https://api.trello.com", methods: ["GET"], pathPatterns: ["/1/members/me/boards", "/1/boards/*", "/1/boards/*/lists", "/1/boards/*/cards"] },
        { baseUrl: "https://api.trello.com", methods: ["POST"], pathPatterns: ["/1/cards", "/1/cards/*/actions/comments"] },
        { baseUrl: "https://api.trello.com", methods: ["PUT"], pathPatterns: ["/1/cards/*"] },
      ],
      standard: [
        { baseUrl: "https://api.trello.com", methods: ["GET"], pathPatterns: ["/1/members/**", "/1/boards/**", "/1/lists/**", "/1/cards/**"] },
        { baseUrl: "https://api.trello.com", methods: ["POST", "PUT", "DELETE"], pathPatterns: ["/1/cards/**", "/1/lists/**", "/1/cards/*/actions/comments"] },
      ],
      minimal: [{ baseUrl: "https://api.trello.com", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/1/**"] }],
    },

    // ── Jira Cloud ──
    "jira-read": {
      strict: [{ baseUrl: "https://*.atlassian.net", methods: ["GET"], pathPatterns: ["/rest/api/3/search", "/rest/api/3/search/jql", "/rest/api/3/issue/*", "/rest/api/3/project"] }],
      standard: [{ baseUrl: "https://*.atlassian.net", methods: ["GET"], pathPatterns: ["/rest/api/3/search", "/rest/api/3/search/jql", "/rest/api/3/issue/**", "/rest/api/3/project/**", "/rest/api/3/myself", "/rest/api/3/user", "/rest/api/3/users/search"] }],
      minimal: [{ baseUrl: "https://*.atlassian.net", methods: ["GET"], pathPatterns: ["/rest/api/3/**"] }],
    },
    "jira-manage": {
      strict: [
        { baseUrl: "https://*.atlassian.net", methods: ["GET"], pathPatterns: ["/rest/api/3/search", "/rest/api/3/search/jql", "/rest/api/3/issue/*", "/rest/api/3/project"] },
        { baseUrl: "https://*.atlassian.net", methods: ["POST"], pathPatterns: ["/rest/api/3/issue", "/rest/api/3/issue/*/comment"] },
        { baseUrl: "https://*.atlassian.net", methods: ["PUT"], pathPatterns: ["/rest/api/3/issue/*"] },
      ],
      standard: [
        { baseUrl: "https://*.atlassian.net", methods: ["GET"], pathPatterns: ["/rest/api/3/search", "/rest/api/3/search/jql", "/rest/api/3/issue/**", "/rest/api/3/project/**", "/rest/api/3/myself"] },
        { baseUrl: "https://*.atlassian.net", methods: ["POST", "PUT", "DELETE"], pathPatterns: ["/rest/api/3/issue/**"] },
        { baseUrl: "https://*.atlassian.net", methods: ["POST"], pathPatterns: ["/rest/api/3/issue/*/transitions"] },
      ],
      minimal: [{ baseUrl: "https://*.atlassian.net", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/rest/api/3/**"] }],
    },
  };

  return allowlistMap[actionTemplateId]?.[tier] || [];
}

// ── Rate limits ──────────────────────────────────────────────────────

/**
 * Get rate limits for an action template tier
 */
function getRateLimitsForAction(actionTemplateId: string, tier: PolicyTier): RateLimit {
  // Telegram: messaging rates (bot API is read+write combined)
  if (actionTemplateId === "telegram") {
    if (tier === "strict") {
      return { maxRequestsPerHour: 30, maxPayloadSizeBytes: 1048576, maxResponseSizeBytes: 5242880 };
    }
    if (tier === "standard") {
      return { maxRequestsPerHour: 200, maxPayloadSizeBytes: 10485760, maxResponseSizeBytes: 10485760 };
    }
    return { maxRequestsPerHour: 1000, maxPayloadSizeBytes: 52428800, maxResponseSizeBytes: 52428800 }; // 50MB (Telegram file limit)
  }

  // LLM providers have their own rate limits
  const provider = resolveProvider(actionTemplateId);
  const isLlm = LLM_PROVIDER_SET.has(provider);
  if (isLlm) {
    if (tier === "strict") {
      return { maxRequestsPerHour: 20, maxPayloadSizeBytes: 1048576, maxResponseSizeBytes: 10485760 }; // 1MB / 10MB
    }
    if (tier === "standard") {
      return { maxRequestsPerHour: 100, maxPayloadSizeBytes: 5242880, maxResponseSizeBytes: 20971520 }; // 5MB / 20MB
    }
    return { maxRequestsPerHour: 500, maxPayloadSizeBytes: 10485760, maxResponseSizeBytes: 52428800 }; // 10MB / 50MB
  }

  // Determine if read or write based on action template ID
  const isWrite = actionTemplateId.endsWith("-write") || actionTemplateId.endsWith("-send") || actionTemplateId.endsWith("-manage") || actionTemplateId.endsWith("-full");

  if (tier === "strict") {
    return {
      maxRequestsPerHour: isWrite ? 25 : 50,
      maxPayloadSizeBytes: isWrite ? 5242880 : 1048576, // 5MB : 1MB
      maxResponseSizeBytes: isWrite ? 1048576 : 5242880, // 1MB : 5MB
    };
  }

  if (tier === "standard") {
    return {
      maxRequestsPerHour: isWrite ? 100 : 200,
      maxPayloadSizeBytes: isWrite ? 10485760 : 5242880, // 10MB : 5MB
      maxResponseSizeBytes: isWrite ? 2097152 : 20971520, // 2MB : 20MB
    };
  }

  // Minimal
  return {
    maxRequestsPerHour: isWrite ? 500 : 1000,
    maxPayloadSizeBytes: isWrite ? 26214400 : 26214400, // 25MB
    maxResponseSizeBytes: isWrite ? 5242880 : 52428800, // 5MB : 50MB
  };
}

// ── Guard rules ──────────────────────────────────────────────────────

/**
 * Get policy rules from guards.
 * Merges all guard rules into a single PolicyRules object.
 */
function getRulesFromGuards(guardIds: string[], actionTemplateId: string): PolicyRules {
  const rules: PolicyRules = { request: [], response: [] };

  const provider = resolveProvider(actionTemplateId);

  for (const guardId of guardIds) {
    const guard = CONTEXTUAL_GUARDS.find((g) => g.id === guardId);
    if (!guard) continue;

    // Get provider-specific rules
    const guardRules = guard.rules[provider];
    if (!guardRules) continue;

    // Merge request and response rules
    if (guardRules.requestRules) {
      rules.request.push(...guardRules.requestRules);
    }
    if (guardRules.responseRules) {
      rules.response.push(...guardRules.responseRules);
    }
  }

  return rules;
}

// ── Base request rules ───────────────────────────────────────────────

/**
 * Generate base request rules based on template type (read vs manage) and tier.
 * These are appended AFTER guard rules as catch-all fallbacks. Guard rules
 * (like "deny DELETE" from dest-delete-protect) take precedence via first-match.
 *
 * This eliminates reliance on stepUpApproval — request rules are the single
 * source of truth for access control on templated policies.
 */
function getBaseRequestRules(actionTemplateId: string, tier: PolicyTier): RequestRule[] {
  const isReadOnly = actionTemplateId.endsWith("-read");

  // Use service-specific preset rules when available.
  // Presets define fine-grained first-match rules (e.g., "Browse recent emails"
  // before "Approve reading email content") that match what the UI displays.
  const presetMap = getPresetsForActionTemplate(actionTemplateId);
  if (presetMap) {
    const preset = presetMap[tier === "standard" ? "standard" : tier === "strict" ? "strict" : "minimal"];
    if (preset?.rules?.request?.length) {
      return preset.rules.request as RequestRule[];
    }
  }

  // Fallback: generic rules for services without action-template-specific presets
  if (isReadOnly) {
    const rules: RequestRule[] = [
      { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
    ];

    // Notion uses POST for read operations (search, database queries).
    // Allow these before the "Block writes" catch-all.
    if (actionTemplateId === "notion-read") {
      rules.push(
        { label: "Allow search", match: { methods: ["POST"], urlPattern: "/v1/search$" }, action: "allow" },
        { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "/v1/databases/.*/query$" }, action: "allow" },
      );
    }

    rules.push({ label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" });
    return rules;
  }

  switch (tier) {
    case "minimal":
      return [
        { label: "Allow all", match: {}, action: "allow" },
      ];
    case "standard":
    case "strict":
      return [
        { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
        { label: "Require approval for writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
      ];
  }
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Generate policy configuration from a template
 */
export function generatePolicyFromTemplate(
  actionTemplateId: string,
  tier: PolicyTier,
  timezone = "UTC",
): PolicyTemplateData {
  const template = getPolicyTemplate(actionTemplateId, tier);
  if (!template) {
    throw new Error(`Policy template not found for ${actionTemplateId} / ${tier}`);
  }

  const allowlists = getAllowlistsForAction(actionTemplateId, tier);
  const rateLimits = getRateLimitsForAction(actionTemplateId, tier);
  const timeWindows: TimeWindow[] = [];
  const rules = getRulesFromGuards(template.guards, actionTemplateId);

  // Append base request rules as catch-all (guard rules take precedence via first-match).
  // This ensures every HTTP method is covered by a rule, so the legacy stepUpApproval
  // fallback in vault.ts is never reached for templated policies.
  rules.request.push(...getBaseRequestRules(actionTemplateId, tier));

  // Append base response rules from presets (e.g., PII redaction).
  // Guard-generated response rules take precedence; preset rules fill gaps.
  const presetMap = getPresetsForActionTemplate(actionTemplateId);
  if (presetMap) {
    const preset = presetMap[tier === "standard" ? "standard" : tier === "strict" ? "strict" : "minimal"];
    if (preset?.rules?.response?.length && rules.response.length === 0) {
      rules.response.push(...(preset.rules.response as ResponseRule[]));
    }
  }

  // Field step-up: balanced contacts allow agents to request full PII via approval.
  // Strict explicitly disables it — PII is permanently stripped.
  // We always set the flag for contacts policies so that switching tiers
  // correctly overwrites any previous value in the DB.
  if (actionTemplateId.includes("contacts")) {
    rules.fieldStepUpEnabled = tier === "standard";
  }

  // Request rules now fully define access control. stepUpApproval is set to "never"
  // so the legacy fallback in vault.ts:checkStepUpApproval() is never reached.
  const stepUpApproval = "never";

  return {
    actionTemplateId,
    tier,
    allowlists,
    rateLimits,
    timeWindows,
    rules,
    stepUpApproval,
  };
}
