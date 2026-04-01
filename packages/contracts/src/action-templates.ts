import { type ServiceId, resolveScopeKeys } from "./services.js";

export interface ActionTemplate {
  id: string;
  serviceId: ServiceId;
  label: string;
  description: string;
  /** Scope keys referencing ServiceScope.key in SERVICE_CATALOG */
  scopeKeys: string[];
  /** Resolved scope URLs (derived from scopeKeys at module load time) */
  scopes: string[];
  requiresApproval: boolean;
}

function t(
  id: string,
  serviceId: ServiceId,
  label: string,
  description: string,
  scopeKeys: string[],
  requiresApproval = false,
): ActionTemplate {
  return { id, serviceId, label, description, scopeKeys, scopes: resolveScopeKeys(serviceId, scopeKeys), requiresApproval };
}

export const ACTION_TEMPLATES: ActionTemplate[] = [
  // ── Gmail ──────────────────────────────────────────────────────
  t("gmail-read",    "google-gmail",    "Read Gmail emails",              "View and search emails",                                                     ["readonly"]),
  t("gmail-manage",  "google-gmail",    "Send and manage Gmail emails",   "Read, send, trash, archive, label • Security tier controls approval",         ["modify", "compose"]),

  // ── Google Calendar ────────────────────────────────────────────
  t("calendar-read",   "google-calendar", "Read Google Calendar",           "View calendar events",                                                     ["events-readonly"]),
  t("calendar-manage", "google-calendar", "Manage Google Calendar events",  "Read, create, edit, delete events • Security tier controls approval",       ["events"]),

  // ── Google Drive ───────────────────────────────────────────────
  t("drive-read",   "google-drive", "Read Google Drive files",    "View and download files",                                             ["readonly"]),
  t("drive-manage", "google-drive", "Manage Google Drive files",  "Read, upload, edit, delete files • Security tier controls approval",   ["full"]),

  // ── Google Docs ────────────────────────────────────────────────
  t("docs-read",   "google-docs", "Read Google Docs",  "View document content",                                                        ["readonly"]),
  t("docs-manage", "google-docs", "Edit Google Docs",  "Read, create, edit documents • Security tier controls approval",                ["readwrite"]),

  // ── Google Sheets ──────────────────────────────────────────────
  t("sheets-read",   "google-sheets", "Read Google Sheets",  "View spreadsheet data",                                                   ["readonly"]),
  t("sheets-manage", "google-sheets", "Edit Google Sheets",  "Read, create, edit spreadsheets • Security tier controls approval",        ["readwrite"]),

  // ── Google Contacts ───────────────────────────────────────────
  t("contacts-read",   "google-contacts", "Read Google Contacts",    "View contact information",                                                       ["readonly"]),
  t("contacts-manage", "google-contacts", "Manage Google Contacts",  "Read, create, edit, delete contacts • Security tier controls approval",           ["readwrite"]),

  // ── Microsoft Teams ────────────────────────────────────────────
  t("teams-read",   "microsoft-teams", "Read Teams chats",    "View chats, messages, and files via Microsoft Graph",                                    ["chat-read", "user-read", "files-read", "offline"]),
  t("teams-manage", "microsoft-teams", "Manage Teams chats",  "Read and send chat messages, manage files • Security tier controls approval",             ["chat-read", "chat-readwrite", "chatmessage-send", "user-read", "files-read", "files-readwrite", "offline"]),

  // ── Microsoft Outlook Mail ─────────────────────────────────────
  t("outlook-read",   "microsoft-outlook-mail", "Read Outlook emails",              "View and search emails",                                            ["mail-read", "user-read", "offline"]),
  t("outlook-manage", "microsoft-outlook-mail", "Send and manage Outlook emails",   "Read, send, manage emails • Security tier controls approval",       ["mail-read", "mail-readwrite", "mail-send", "user-read", "offline"]),

  // ── Microsoft Outlook Calendar ─────────────────────────────────
  t("outlook-calendar-read",   "microsoft-outlook-calendar", "Read Outlook Calendar",           "View calendar events",                                           ["calendars-read", "user-read", "offline"]),
  t("outlook-calendar-manage", "microsoft-outlook-calendar", "Manage Outlook Calendar events",  "Read, create, edit, delete events • Security tier controls approval", ["calendars-readwrite", "user-read", "offline"]),

  // ── Microsoft OneDrive ─────────────────────────────────────────
  t("onedrive-read",   "microsoft-onedrive", "Read OneDrive files",    "View and download files",                                              ["files-read", "user-read", "offline"]),
  t("onedrive-manage", "microsoft-onedrive", "Manage OneDrive files",  "Read, upload, edit, delete files • Security tier controls approval",    ["files-readwrite", "user-read", "offline"]),

  // ── Microsoft Outlook Contacts ─────────────────────────────────
  t("outlook-contacts-read",   "microsoft-outlook-contacts", "Read Outlook contacts",    "View contact information",                                                       ["contacts-read", "user-read", "offline"]),
  t("outlook-contacts-manage", "microsoft-outlook-contacts", "Manage Outlook contacts",  "Read, create, edit, delete contacts • Security tier controls approval",           ["contacts-readwrite", "user-read", "offline"]),

  // ── Telegram ───────────────────────────────────────────────────
  t("telegram", "telegram", "Telegram Bot access", "Send and receive messages via Telegram Bot API • Security tier controls approval", []),

  // ── Slack ──────────────────────────────────────────────────────
  t("slack", "slack", "Slack Bot access", "Read and send messages, upload files, manage reactions • Security tier controls approval", []),

  // ── LLM Providers ──────────────────────────────────────────────
  t("anthropic-messages", "anthropic-messages", "Use Claude models",     "Call Claude models via Messages API • No approval by default",                    []),
  t("openai",             "openai",             "Use OpenAI models",     "Chat completions, embeddings, and model listing • Security tier controls approval", []),
  t("gemini",             "gemini",             "Use Gemini models",     "Content generation, embeddings, and model listing • Security tier controls approval", []),
  t("openrouter",         "openrouter",         "Use OpenRouter models", "Chat completions and model listing via OpenRouter • Security tier controls approval", []),

  // ── Project Management ─────────────────────────────────────────
  t("notion-read",   "notion", "Read Notion pages",      "Search and read pages, databases, and blocks",                                        []),
  t("notion-manage", "notion", "Manage Notion content",  "Read, create, update pages and databases • Security tier controls approval",           []),
  t("trello-read",   "trello", "Read Trello boards",     "View boards, lists, cards, and labels",                                               []),
  t("trello-manage", "trello", "Manage Trello content",  "Read, create, update cards and lists • Security tier controls approval",               []),
  t("jira-read",     "jira",   "Read Jira issues",       "Search and read issues, projects, and comments",                                      []),
  t("jira-manage",   "jira",   "Manage Jira issues",     "Read, create, update issues and comments • Security tier controls approval",           []),
];

/** Validate an action template ID */
export function isValidActionTemplateId(id: string): boolean {
  return ACTION_TEMPLATES.some((t) => t.id === id);
}

/** Get an action template by ID */
export function getActionTemplate(id: string): ActionTemplate | undefined {
  return ACTION_TEMPLATES.find((t) => t.id === id);
}

/** Get action templates for a service ID (e.g., "google-gmail" → ["gmail-read", "gmail-manage"]) */
export function getActionTemplatesForService(serviceId: string): ActionTemplate[] {
  return ACTION_TEMPLATES.filter((t) => t.serviceId === serviceId);
}
