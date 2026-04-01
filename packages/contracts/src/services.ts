import type { OAuthProvider } from "./oauth.js";

/**
 * Service catalog — defines the available services for connections.
 * Each service maps to an OAuth provider (connector) and a curated scope set.
 */

export const SERVICE_IDS = [
  "google-gmail",
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-contacts",
  "microsoft-teams",
  "microsoft-outlook-mail",
  "microsoft-outlook-calendar",
  "microsoft-onedrive",
  "microsoft-outlook-contacts",
  "telegram",
  "slack",
  "anthropic-messages",
  "openai",
  "gemini",
  "openrouter",
  "notion",
  "trello",
  "jira",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

export type ServiceCategory = "llm" | "communication" | "data";

export type CredentialType = "oauth" | "api_key" | "bot_token";

/** Ordered list of categories (controls tab rendering order) */
export const SERVICE_CATEGORIES: ServiceCategory[] = ["llm", "communication", "data"];

/** Human-readable labels for each category */
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  llm: "LLM Access",
  communication: "Chat with OpenClaw",
  data: "Accounts OpenClaw can access",
};

export interface ServiceScope {
  /** Short key unique within a service (e.g., "modify", "readonly"). Used by action templates to reference scopes without hardcoding URLs. */
  key: string;
  value: string;
  label: string;
  /** Whether this scope is selected by default */
  default: boolean;
}

export interface ServiceCatalogEntry {
  provider: OAuthProvider;
  displayName: string;
  /** Single-char icon for avatar */
  icon: string;
  description: string;
  /** Provider group label for UI grouping */
  group: string;
  /** Functional category for tabbed UI */
  category: ServiceCategory;
  scopes: ServiceScope[];
  /**
   * Whether only one connection of this service should exist per workspace.
   * - true: Agent identity services (bot tokens, LLM providers) - one per workspace
   * - false: User-delegated services (OAuth multi-account scenarios like personal + work Gmail)
   */
  singleton: boolean;
  /** How credentials are collected and stored. Determines onboarding flow and revocation semantics. */
  credentialType: CredentialType;
  /**
   * Which execution models are supported. If omitted, defaults to ["A", "B"].
   * - Bot tokens / API keys: ["B"] only — Model A would expose the credential permanently.
   * - OAuth: ["A", "B"] — Model A vends short-lived access tokens.
   */
  allowedModels?: ("A" | "B")[];
  /** Path to documentation page (e.g., "/connections/google") */
  docsPath?: string;
}

export const SERVICE_CATALOG: Record<ServiceId, ServiceCatalogEntry> = {
  // ── Google services ──────────────────────────────────────────
  "google-gmail": {
    provider: "google",
    displayName: "Gmail",
    icon: "✉",
    description: "Send and manage Gmail emails",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "modify", value: "https://www.googleapis.com/auth/gmail.modify", label: "Read, send, and manage emails (archive, trash, label)", default: true },
      { key: "compose", value: "https://www.googleapis.com/auth/gmail.compose", label: "Compose and edit drafts", default: true },
      { key: "readonly", value: "https://www.googleapis.com/auth/gmail.readonly", label: "Read emails only (no send or manage)", default: false },
      { key: "send", value: "https://www.googleapis.com/auth/gmail.send", label: "Send emails only", default: false },
      { key: "labels", value: "https://www.googleapis.com/auth/gmail.labels", label: "Manage email labels", default: false },
    ],
  },
  "google-calendar": {
    provider: "google",
    displayName: "Google Calendar",
    icon: "📅",
    description: "Read and manage calendar events",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "events-readonly", value: "https://www.googleapis.com/auth/calendar.events.readonly", label: "Read calendar events", default: true },
      { key: "events", value: "https://www.googleapis.com/auth/calendar.events", label: "Create and edit calendar events", default: true },
      { key: "readonly", value: "https://www.googleapis.com/auth/calendar.readonly", label: "Read all calendar data", default: false },
    ],
  },
  "google-drive": {
    provider: "google",
    displayName: "Google Drive",
    icon: "📁",
    description: "Read and manage Drive files",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "readonly", value: "https://www.googleapis.com/auth/drive.readonly", label: "Read Drive files", default: true },
      { key: "file", value: "https://www.googleapis.com/auth/drive.file", label: "Create and edit Drive files", default: true },
      { key: "full", value: "https://www.googleapis.com/auth/drive", label: "Full Drive access", default: false },
    ],
  },
  "google-sheets": {
    provider: "google",
    displayName: "Google Sheets",
    icon: "📊",
    description: "Read and edit spreadsheets",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "readonly", value: "https://www.googleapis.com/auth/spreadsheets.readonly", label: "Read spreadsheets", default: true },
      { key: "readwrite", value: "https://www.googleapis.com/auth/spreadsheets", label: "Read and edit spreadsheets", default: true },
    ],
  },
  "google-docs": {
    provider: "google",
    displayName: "Google Docs",
    icon: "📝",
    description: "Read and edit documents",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "readonly", value: "https://www.googleapis.com/auth/documents.readonly", label: "Read documents", default: true },
      { key: "readwrite", value: "https://www.googleapis.com/auth/documents", label: "Read and edit documents", default: true },
    ],
  },

  "google-contacts": {
    provider: "google",
    displayName: "Google Contacts",
    icon: "👤",
    description: "Read and manage Google contacts",
    group: "Google",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/google",
    scopes: [
      { key: "readonly", value: "https://www.googleapis.com/auth/contacts.readonly", label: "Read contacts", default: true },
      { key: "readwrite", value: "https://www.googleapis.com/auth/contacts", label: "Read and edit contacts", default: true },
    ],
  },
  "microsoft-teams": {
    provider: "microsoft",
    displayName: "Microsoft Teams",
    icon: "💬",
    description: "Access Teams chats and files via Microsoft Graph",
    group: "Microsoft",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/microsoft",
    scopes: [
      { key: "chat-read", value: "Chat.Read", label: "Read chat messages", default: true },
      { key: "chat-readwrite", value: "Chat.ReadWrite", label: "Read and send chat messages", default: true },
      { key: "chatmessage-send", value: "ChatMessage.Send", label: "Send messages", default: true },
      { key: "user-read", value: "User.Read", label: "Read your profile", default: true },
      { key: "files-read", value: "Files.Read.All", label: "Read accessible files", default: true },
      { key: "files-readwrite", value: "Files.ReadWrite.All", label: "Upload and share files", default: true },
      { key: "offline", value: "offline_access", label: "Stay signed in", default: true },
      { key: "channel-read", value: "ChannelMessage.Read.All", label: "Read channel messages (admin)", default: false },
      { key: "channel-send", value: "ChannelMessage.Send", label: "Send channel messages (admin)", default: false },
    ],
  },
  "microsoft-outlook-mail": {
    provider: "microsoft",
    displayName: "Outlook Mail",
    icon: "📧",
    description: "Read and send Outlook emails",
    group: "Microsoft",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/microsoft",
    scopes: [
      { key: "mail-read", value: "Mail.Read", label: "Read emails", default: true },
      { key: "mail-readwrite", value: "Mail.ReadWrite", label: "Read and write emails", default: false },
      { key: "mail-send", value: "Mail.Send", label: "Send emails", default: true },
      { key: "user-read", value: "User.Read", label: "Read your profile", default: true },
      { key: "offline", value: "offline_access", label: "Stay signed in", default: true },
    ],
  },
  "microsoft-outlook-calendar": {
    provider: "microsoft",
    displayName: "Outlook Calendar",
    icon: "📆",
    description: "Read and manage Outlook calendar",
    group: "Microsoft",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/microsoft",
    scopes: [
      { key: "calendars-read", value: "Calendars.Read", label: "Read calendar events", default: true },
      { key: "calendars-readwrite", value: "Calendars.ReadWrite", label: "Create and edit events", default: true },
      { key: "user-read", value: "User.Read", label: "Read your profile", default: true },
      { key: "offline", value: "offline_access", label: "Stay signed in", default: true },
    ],
  },

  "microsoft-onedrive": {
    provider: "microsoft",
    displayName: "OneDrive",
    icon: "📁",
    description: "Read and manage OneDrive files",
    group: "Microsoft",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/microsoft",
    scopes: [
      { key: "files-read", value: "Files.Read", label: "Read files", default: true },
      { key: "files-readwrite", value: "Files.ReadWrite", label: "Read and write files", default: true },
      { key: "user-read", value: "User.Read", label: "Read your profile", default: true },
      { key: "offline", value: "offline_access", label: "Stay signed in", default: true },
    ],
  },

  "microsoft-outlook-contacts": {
    provider: "microsoft",
    displayName: "Outlook Contacts",
    icon: "👤",
    description: "Read and manage Outlook contacts",
    group: "Microsoft",
    category: "data",
    singleton: false,
    credentialType: "oauth",
    docsPath: "/connections/microsoft",
    scopes: [
      { key: "contacts-read", value: "Contacts.Read", label: "Read contacts", default: true },
      { key: "contacts-readwrite", value: "Contacts.ReadWrite", label: "Create and edit contacts", default: true },
      { key: "user-read", value: "User.Read", label: "Read your profile", default: true },
      { key: "offline", value: "offline_access", label: "Stay signed in", default: true },
    ],
  },

  // ── Telegram ─────────────────────────────────────────────────
  telegram: {
    provider: "telegram",
    displayName: "Telegram Bot",
    icon: "🤖",
    description: "Talk to OpenClaw via Telegram",
    group: "Telegram",
    category: "communication",
    singleton: true,
    credentialType: "bot_token",
    allowedModels: ["B"],
    docsPath: "/connections/telegram",
    scopes: [],
  },

  // ── Slack ────────────────────────────────────────────────────
  slack: {
    provider: "slack",
    displayName: "Slack Bot",
    icon: "💬",
    description: "Talk to OpenClaw in Slack",
    group: "Slack",
    category: "communication",
    singleton: true,
    credentialType: "bot_token",
    allowedModels: ["B"],
    docsPath: "/connections/slack",
    scopes: [],
  },

  // ── Anthropic ─────────────────────────────────────────────────
  "anthropic-messages": {
    provider: "anthropic",
    displayName: "Anthropic (Claude)",
    icon: "🧠",
    description: "Claude LLM API via Messages endpoint",
    group: "Anthropic",
    category: "llm",
    singleton: true,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/anthropic",
    scopes: [],
  },

  // ── OpenAI ──────────────────────────────────────────────────
  openai: {
    provider: "openai",
    displayName: "OpenAI",
    icon: "🤖",
    description: "GPT models and embeddings API",
    group: "OpenAI",
    category: "llm",
    singleton: true,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/openai",
    scopes: [],
  },

  // ── Google Gemini ───────────────────────────────────────────
  gemini: {
    provider: "gemini",
    displayName: "Google Gemini",
    icon: "✨",
    description: "Gemini models and embeddings API",
    group: "Google AI",
    category: "llm",
    singleton: true,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/gemini",
    scopes: [],
  },

  // ── OpenRouter ────────────────────────────────────────────
  openrouter: {
    provider: "openrouter",
    displayName: "OpenRouter",
    icon: "🔀",
    description: "Multi-model LLM gateway (OpenAI-compatible)",
    group: "OpenRouter",
    category: "llm",
    singleton: true,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/openrouter",
    scopes: [],
  },

  // ── Notion ──────────────────────────────────────────────
  notion: {
    provider: "notion",
    displayName: "Notion",
    icon: "📝",
    description: "Read and manage Notion pages, databases, and blocks",
    group: "Notion",
    category: "data",
    singleton: false,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/notion",
    scopes: [],
  },
  // ── Trello ─────────────────────────────────────────────
  trello: {
    provider: "trello",
    displayName: "Trello",
    icon: "📋",
    description: "Read and manage Trello boards, lists, and cards",
    group: "Trello",
    category: "data",
    singleton: false,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/trello",
    scopes: [],
  },
  // ── Jira Cloud ──────────────────────────────────────────
  jira: {
    provider: "jira",
    displayName: "Jira Cloud",
    icon: "🎫",
    description: "Search, create, and manage Jira issues, projects, and comments",
    group: "Atlassian",
    category: "data",
    singleton: false,
    credentialType: "api_key",
    allowedModels: ["B"],
    docsPath: "/connections/jira",
    scopes: [],
  },
};

/** Derive the OAuth provider from a service ID */
export function getProviderForService(serviceId: ServiceId): OAuthProvider {
  return SERVICE_CATALOG[serviceId].provider;
}

/** Get allowed execution models for a service (defaults to ["A", "B"] if not specified) */
export function getAllowedModelsForService(serviceId: ServiceId): ("A" | "B")[] {
  return SERVICE_CATALOG[serviceId].allowedModels ?? ["B"];
}

/** Whether revocation is instant for this service (true when credential isn't vended to agent) */
export function isRevocationInstant(serviceId: ServiceId): boolean {
  return SERVICE_CATALOG[serviceId].credentialType !== "oauth"
    || !getAllowedModelsForService(serviceId).includes("A");
}

/** Get default scopes for a service (those with default: true) */
export function getDefaultScopes(serviceId: ServiceId): string[] {
  return SERVICE_CATALOG[serviceId].scopes
    .filter((s) => s.default)
    .map((s) => s.value);
}

/**
 * Resolve scope keys to scope URL values for a given service.
 * Action templates use this to reference scopes by short key instead of
 * hardcoding full URLs — single source of truth in SERVICE_CATALOG.
 * Throws at module load time if a key is invalid (prevents silent drift).
 */
export function resolveScopeKeys(serviceId: ServiceId, keys: string[]): string[] {
  const entry = SERVICE_CATALOG[serviceId];
  return keys.map(key => {
    const scope = entry.scopes.find(s => s.key === key);
    if (!scope) {
      throw new Error(
        `Unknown scope key "${key}" for service "${serviceId}". ` +
        `Valid keys: ${entry.scopes.map(s => s.key).join(", ")}`,
      );
    }
    return scope.value;
  });
}

/** Get services for a given category, returned as [serviceId, entry] pairs */
export function getServicesByCategory(
  category: ServiceCategory,
): [ServiceId, ServiceCatalogEntry][] {
  return (Object.entries(SERVICE_CATALOG) as [ServiceId, ServiceCatalogEntry][]).filter(
    ([, entry]) => entry.category === category,
  );
}
