import type { AllowlistEntry } from "./policy.js";

export interface AllowlistTemplate {
  id: string;
  name: string;
  description: string;
  provider: string;
  /** Whether this template involves write operations that should use step-up approval */
  sensitive: boolean;
  allowlists: AllowlistEntry[];
}

/**
 * Google Workspace default allowlist templates.
 * Stored in code (not database) per acceptance criteria.
 */
export const GOOGLE_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "google-gmail-read",
    name: "Gmail - Read Only",
    description: "Read emails and threads from Gmail",
    provider: "google",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://www.googleapis.com",
        methods: ["GET"],
        pathPatterns: [
          "/gmail/v1/users/me/messages/*",
          "/gmail/v1/users/me/threads/*",
        ],
      },
    ],
  },
  {
    id: "google-gmail-send",
    name: "Gmail - Send Email",
    description: "Send emails via Gmail (requires step-up approval)",
    provider: "google",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://www.googleapis.com",
        methods: ["POST"],
        pathPatterns: ["/gmail/v1/users/me/messages/send"],
      },
    ],
  },
  {
    id: "google-calendar-read",
    name: "Google Calendar - Read Only",
    description: "Read calendar events and calendar list",
    provider: "google",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://www.googleapis.com",
        methods: ["GET"],
        pathPatterns: [
          "/calendar/v3/calendars/*/events/*",
          "/calendar/v3/users/me/calendarList",
        ],
      },
    ],
  },
  {
    id: "google-drive-read",
    name: "Google Drive - Read Only",
    description: "Read and export files from Google Drive",
    provider: "google",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://www.googleapis.com",
        methods: ["GET"],
        pathPatterns: [
          "/drive/v3/files/*",
          "/drive/v3/files/*/export",
        ],
      },
    ],
  },
];

/**
 * Google Docs API fine-grained allowlist templates.
 */
export const GOOGLE_DOCS_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "google-docs-read",
    name: "Google Docs - Read Only",
    description: "Read documents from Google Docs",
    provider: "google",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://docs.googleapis.com",
        methods: ["GET"],
        pathPatterns: ["/v1/documents/*"],
      },
    ],
  },
  {
    id: "google-docs-write",
    name: "Google Docs - Create & Edit",
    description: "Create and edit documents (requires step-up approval)",
    provider: "google",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://docs.googleapis.com",
        methods: ["POST"],
        pathPatterns: ["/v1/documents", "/v1/documents/*:batchUpdate"],
      },
    ],
  },
];

/**
 * Google Sheets API fine-grained allowlist templates.
 */
export const GOOGLE_SHEETS_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "google-sheets-read",
    name: "Google Sheets - Read Only",
    description: "Read spreadsheet data and metadata",
    provider: "google",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://sheets.googleapis.com",
        methods: ["GET"],
        pathPatterns: [
          "/v4/spreadsheets/*",
          "/v4/spreadsheets/*/values/*",
        ],
      },
    ],
  },
  {
    id: "google-sheets-write",
    name: "Google Sheets - Create & Edit",
    description: "Create spreadsheets and update cell values (requires step-up approval)",
    provider: "google",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://sheets.googleapis.com",
        methods: ["POST"],
        pathPatterns: [
          "/v4/spreadsheets",
          "/v4/spreadsheets/*:batchUpdate",
          "/v4/spreadsheets/*/values/*:append",
        ],
      },
      {
        baseUrl: "https://sheets.googleapis.com",
        methods: ["PUT"],
        pathPatterns: ["/v4/spreadsheets/*/values/*"],
      },
    ],
  },
];

/**
 * Telegram Bot API default allowlist templates.
 * Stored in code (not database) per acceptance criteria.
 */
export const TELEGRAM_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "telegram-send-message",
    name: "Telegram - Send Message",
    description: "Send messages to allowed chats via Telegram Bot API",
    provider: "telegram",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.telegram.org",
        methods: ["POST"],
        pathPatterns: ["/bot*/sendMessage"],
      },
    ],
  },
  {
    id: "telegram-get-updates",
    name: "Telegram - Get Updates",
    description: "Receive messages and updates from Telegram Bot API",
    provider: "telegram",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.telegram.org",
        methods: ["POST"],
        pathPatterns: ["/bot*/getUpdates"],
      },
    ],
  },
];

/**
 * Microsoft Teams / Graph API default allowlist templates.
 * Stored in code (not database) per acceptance criteria.
 */
export const MICROSOFT_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "microsoft-chat-read",
    name: "Microsoft Teams - Read Chats",
    description: "Read chat messages and conversations via Microsoft Graph",
    provider: "microsoft",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["GET"],
        pathPatterns: [
          "/v1.0/me/chats/*",
          "/v1.0/chats/*/messages/*",
          "/v1.0/me/chats/*/messages/*",
        ],
      },
    ],
  },
  {
    id: "microsoft-chat-send",
    name: "Microsoft Teams - Send Chat Messages",
    description: "Send messages in Teams chats (requires step-up approval)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["POST"],
        pathPatterns: [
          "/v1.0/chats/*/messages",
          "/v1.0/me/chats/*/messages",
        ],
      },
    ],
  },
  {
    id: "microsoft-channel-read",
    name: "Microsoft Teams - Read Channel Messages",
    description: "Read channel messages from Teams channels via Microsoft Graph",
    provider: "microsoft",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["GET"],
        pathPatterns: [
          "/v1.0/teams/*/channels/*",
          "/v1.0/teams/*/channels/*/messages/*",
        ],
      },
    ],
  },
  {
    id: "microsoft-channel-send",
    name: "Microsoft Teams - Send Channel Messages",
    description: "Send messages in Teams channels (configurable approval)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["POST"],
        pathPatterns: [
          "/v1.0/teams/*/channels/*/messages",
        ],
      },
    ],
  },
  {
    id: "microsoft-user-profile",
    name: "Microsoft - User Profile",
    description: "Read your Microsoft profile information",
    provider: "microsoft",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["GET"],
        pathPatterns: [
          "/v1.0/me",
        ],
      },
    ],
  },
  // OneDrive
  {
    id: "microsoft-onedrive-read",
    name: "OneDrive - Read Files",
    description: "List, search, and read files from OneDrive",
    provider: "microsoft",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["GET"],
        pathPatterns: [
          "/v1.0/me/drive/*",
          "/v1.0/drives/*",
        ],
      },
    ],
  },
  {
    id: "microsoft-onedrive-upload",
    name: "OneDrive - Upload Files",
    description: "Upload files to OneDrive (PUT to /content endpoint)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["PUT"],
        pathPatterns: [
          "/v1.0/me/drive/root:/*:/content",
          "/v1.0/me/drive/items/*/content",
        ],
      },
    ],
  },
  {
    id: "microsoft-onedrive-manage",
    name: "OneDrive - Manage Files & Folders",
    description: "Create folders, move, copy, and delete files",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["POST", "PATCH", "DELETE"],
        pathPatterns: [
          "/v1.0/me/drive/root/children",
          "/v1.0/me/drive/items/*",
          "/v1.0/me/drive/items/*/children",
        ],
      },
    ],
  },
  {
    id: "microsoft-onedrive-share",
    name: "OneDrive - Share Files",
    description: "Create sharing links and invite collaborators (requires step-up approval)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["POST"],
        pathPatterns: [
          "/v1.0/me/drive/items/*/createLink",
          "/v1.0/me/drive/items/*/invite",
        ],
      },
    ],
  },
  // Outlook Contacts
  {
    id: "microsoft-contacts-read",
    name: "Outlook Contacts - Read",
    description: "List, search, and read contacts from Outlook",
    provider: "microsoft",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["GET"],
        pathPatterns: [
          "/v1.0/me/contacts",
          "/v1.0/me/contacts/*",
          "/v1.0/me/contactFolders",
          "/v1.0/me/contactFolders/*",
          "/v1.0/me/people",
        ],
      },
    ],
  },
  {
    id: "microsoft-contacts-write",
    name: "Outlook Contacts - Create & Update",
    description: "Create, update, and manage contacts (requires step-up approval)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["POST", "PATCH"],
        pathPatterns: [
          "/v1.0/me/contacts",
          "/v1.0/me/contacts/*",
          "/v1.0/me/contactFolders/*/contacts",
        ],
      },
    ],
  },
  {
    id: "microsoft-contacts-delete",
    name: "Outlook Contacts - Delete",
    description: "Delete contacts (requires step-up approval)",
    provider: "microsoft",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://graph.microsoft.com",
        methods: ["DELETE"],
        pathPatterns: [
          "/v1.0/me/contacts/*",
        ],
      },
    ],
  },
];

/**
 * Slack API default allowlist templates.
 */
export const SLACK_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "slack",
    name: "Slack - Full Bot Access",
    description: "Read and send messages, upload files, manage reactions and pins",
    provider: "slack",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://slack.com",
        methods: ["POST"],
        pathPatterns: [
          "/api/conversations.history",
          "/api/conversations.replies",
          "/api/conversations.list",
          "/api/conversations.info",
          "/api/users.info",
          "/api/users.list",
          "/api/emoji.list",
          "/api/pins.list",
          "/api/chat.postMessage",
          "/api/chat.update",
          "/api/chat.delete",
          "/api/files.uploadV2",
          "/api/reactions.add",
          "/api/reactions.remove",
          "/api/pins.add",
          "/api/pins.remove",
        ],
      },
    ],
  },
];

/**
 * Anthropic API default allowlist templates.
 */
export const ANTHROPIC_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "anthropic-messages",
    name: "Anthropic - Messages API",
    description: "Create messages via Claude API",
    provider: "anthropic",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.anthropic.com",
        methods: ["POST"],
        pathPatterns: ["/v1/messages"],
      },
    ],
  },
  {
    id: "anthropic-models",
    name: "Anthropic - List Models",
    description: "List available Claude models",
    provider: "anthropic",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.anthropic.com",
        methods: ["GET"],
        pathPatterns: ["/v1/models", "/v1/models/*"],
      },
    ],
  },
];

/**
 * OpenRouter API default allowlist templates.
 */
export const OPENROUTER_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "openrouter",
    name: "OpenRouter - Chat Completions",
    description: "Send chat completion requests via OpenRouter",
    provider: "openrouter",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://openrouter.ai",
        methods: ["POST"],
        pathPatterns: ["/api/v1/chat/completions"],
      },
    ],
  },
  {
    id: "openrouter-models",
    name: "OpenRouter - List Models",
    description: "List available models on OpenRouter",
    provider: "openrouter",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://openrouter.ai",
        methods: ["GET"],
        pathPatterns: ["/api/v1/models", "/api/v1/models/*"],
      },
    ],
  },
];

/**
 * Notion API default allowlist templates.
 * Note: Notion uses POST for read operations (search, database queries).
 */
export const NOTION_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "notion-read-pages",
    name: "Notion - Read Pages",
    description: "Read pages and page properties from Notion",
    provider: "notion",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["GET"],
        pathPatterns: ["/v1/pages/*", "/v1/pages/*/properties/*"],
      },
    ],
  },
  {
    id: "notion-read-databases",
    name: "Notion - Read Databases",
    description: "Read and query databases (uses POST for queries)",
    provider: "notion",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["GET"],
        pathPatterns: ["/v1/databases/*"],
      },
      {
        baseUrl: "https://api.notion.com",
        methods: ["POST"],
        pathPatterns: ["/v1/databases/*/query"],
      },
    ],
  },
  {
    id: "notion-read-blocks",
    name: "Notion - Read Blocks",
    description: "Read block content and children from Notion",
    provider: "notion",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["GET"],
        pathPatterns: ["/v1/blocks/*", "/v1/blocks/*/children"],
      },
    ],
  },
  {
    id: "notion-search",
    name: "Notion - Search",
    description: "Search pages and databases (uses POST)",
    provider: "notion",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["POST"],
        pathPatterns: ["/v1/search"],
      },
    ],
  },
  {
    id: "notion-write-pages",
    name: "Notion - Write Pages",
    description: "Create and update pages (requires step-up approval)",
    provider: "notion",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["POST"],
        pathPatterns: ["/v1/pages"],
      },
      {
        baseUrl: "https://api.notion.com",
        methods: ["PATCH"],
        pathPatterns: ["/v1/pages/*"],
      },
    ],
  },
  {
    id: "notion-write-blocks",
    name: "Notion - Write Blocks",
    description: "Create, update, and delete blocks (requires step-up approval)",
    provider: "notion",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["PATCH"],
        pathPatterns: ["/v1/blocks/*", "/v1/blocks/*/children"],
      },
      {
        baseUrl: "https://api.notion.com",
        methods: ["DELETE"],
        pathPatterns: ["/v1/blocks/*"],
      },
    ],
  },
  {
    id: "notion-comments",
    name: "Notion - Comments",
    description: "Read and create comments on pages and blocks",
    provider: "notion",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.notion.com",
        methods: ["GET", "POST"],
        pathPatterns: ["/v1/comments"],
      },
    ],
  },
];

// ── Trello ──────────────────────────────────────────────────
export const TRELLO_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "trello-read-boards",
    name: "Trello - Read Boards",
    description: "List and read boards, including lists, cards, and labels",
    provider: "trello",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["GET"],
        pathPatterns: ["/1/members/me/boards", "/1/boards/*", "/1/boards/*/lists", "/1/boards/*/cards", "/1/boards/*/labels", "/1/boards/*/members"],
      },
    ],
  },
  {
    id: "trello-read-lists",
    name: "Trello - Read Lists",
    description: "Read lists and their cards",
    provider: "trello",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["GET"],
        pathPatterns: ["/1/lists/*", "/1/lists/*/cards"],
      },
    ],
  },
  {
    id: "trello-read-cards",
    name: "Trello - Read Cards",
    description: "Read cards, actions, attachments, and checklists",
    provider: "trello",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["GET"],
        pathPatterns: ["/1/cards/*", "/1/cards/*/actions", "/1/cards/*/attachments", "/1/cards/*/checklists", "/1/cards/*/members"],
      },
    ],
  },
  {
    id: "trello-write-cards",
    name: "Trello - Write Cards",
    description: "Create, update cards and add comments",
    provider: "trello",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["POST"],
        pathPatterns: ["/1/cards", "/1/cards/*/actions/comments"],
      },
      {
        baseUrl: "https://api.trello.com",
        methods: ["PUT"],
        pathPatterns: ["/1/cards/*"],
      },
    ],
  },
  {
    id: "trello-write-lists",
    name: "Trello - Write Lists",
    description: "Create and update lists",
    provider: "trello",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["POST"],
        pathPatterns: ["/1/lists"],
      },
      {
        baseUrl: "https://api.trello.com",
        methods: ["PUT"],
        pathPatterns: ["/1/lists/*"],
      },
    ],
  },
  {
    id: "trello-delete",
    name: "Trello - Delete",
    description: "Delete cards and other resources (destructive)",
    provider: "trello",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://api.trello.com",
        methods: ["DELETE"],
        pathPatterns: ["/1/cards/*", "/1/boards/*"],
      },
    ],
  },
];

export const JIRA_ALLOWLIST_TEMPLATES: AllowlistTemplate[] = [
  {
    id: "jira-read-issues",
    name: "Jira - Read Issues",
    description: "Search and read issues, including comments and changelogs",
    provider: "jira",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["GET"],
        pathPatterns: ["/rest/api/3/search", "/rest/api/3/search/jql", "/rest/api/3/issue/*", "/rest/api/3/issue/*/comment", "/rest/api/3/issue/*/changelog"],
      },
    ],
  },
  {
    id: "jira-read-projects",
    name: "Jira - Read Projects",
    description: "List and read projects and their metadata",
    provider: "jira",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["GET"],
        pathPatterns: ["/rest/api/3/project", "/rest/api/3/project/*", "/rest/api/3/project/*/statuses"],
      },
    ],
  },
  {
    id: "jira-read-users",
    name: "Jira - Read Users",
    description: "Read current user and user information",
    provider: "jira",
    sensitive: false,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["GET"],
        pathPatterns: ["/rest/api/3/myself", "/rest/api/3/user", "/rest/api/3/users/search"],
      },
    ],
  },
  {
    id: "jira-write-issues",
    name: "Jira - Write Issues",
    description: "Create and update issues",
    provider: "jira",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["POST"],
        pathPatterns: ["/rest/api/3/issue"],
      },
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["PUT"],
        pathPatterns: ["/rest/api/3/issue/*"],
      },
    ],
  },
  {
    id: "jira-write-comments",
    name: "Jira - Write Comments",
    description: "Add comments to issues",
    provider: "jira",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["POST"],
        pathPatterns: ["/rest/api/3/issue/*/comment"],
      },
    ],
  },
  {
    id: "jira-transitions",
    name: "Jira - Transition Issues",
    description: "Transition issues through workflow states",
    provider: "jira",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["GET", "POST"],
        pathPatterns: ["/rest/api/3/issue/*/transitions"],
      },
    ],
  },
  {
    id: "jira-delete",
    name: "Jira - Delete",
    description: "Delete issues (destructive)",
    provider: "jira",
    sensitive: true,
    allowlists: [
      {
        baseUrl: "https://*.atlassian.net",
        methods: ["DELETE"],
        pathPatterns: ["/rest/api/3/issue/*"],
      },
    ],
  },
];

/**
 * All provider allowlist templates indexed by provider name.
 */
export const ALLOWLIST_TEMPLATES: Record<string, AllowlistTemplate[]> = {
  google: GOOGLE_ALLOWLIST_TEMPLATES,
  "google-docs": GOOGLE_DOCS_ALLOWLIST_TEMPLATES,
  "google-sheets": GOOGLE_SHEETS_ALLOWLIST_TEMPLATES,
  telegram: TELEGRAM_ALLOWLIST_TEMPLATES,
  microsoft: MICROSOFT_ALLOWLIST_TEMPLATES,
  slack: SLACK_ALLOWLIST_TEMPLATES,
  anthropic: ANTHROPIC_ALLOWLIST_TEMPLATES,
  openrouter: OPENROUTER_ALLOWLIST_TEMPLATES,
  notion: NOTION_ALLOWLIST_TEMPLATES,
  trello: TRELLO_ALLOWLIST_TEMPLATES,
  jira: JIRA_ALLOWLIST_TEMPLATES,
};

/**
 * Default allowlists auto-applied when a policy is created for a service.
 * Broader than the fine-grained templates — scoped to the service's API namespace.
 * OAuth token scopes + defaultMode + stepUpApproval provide additional gating.
 */
const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export const SERVICE_DEFAULT_ALLOWLISTS: Record<string, AllowlistEntry[]> = {
  // ── Google services (each scoped to its API namespace) ──
  // Use ** (deep glob) because API paths are multi-segment
  // (e.g. /gmail/v1/users/me/messages/{id}/attachments/{aid})
  "google-gmail": [
    { baseUrl: "https://www.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/gmail/v1/**"] },
  ],
  "google-calendar": [
    { baseUrl: "https://www.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/calendar/v3/**"] },
  ],
  "google-drive": [
    { baseUrl: "https://www.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/drive/v3/**"] },
    { baseUrl: "https://www.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/upload/drive/v3/**"] },
  ],
  "google-sheets": [
    { baseUrl: "https://sheets.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/v4/spreadsheets/**"] },
  ],
  "google-docs": [
    { baseUrl: "https://docs.googleapis.com", methods: [...ALL_METHODS], pathPatterns: ["/v1/documents/**"] },
  ],
  "google-contacts": [
    { baseUrl: "https://people.googleapis.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1/people/**",
      "/v1/people:*",
      "/v1/contactGroups/**",
      "/v1/contactGroups:*",
      "/v1/otherContacts/**",
      "/v1/otherContacts:*",
    ]},
  ],

  // ── Telegram (all bot API methods) ──
  telegram: [
    { baseUrl: "https://api.telegram.org", methods: ["GET", "POST"], pathPatterns: ["/bot*/*"] },
  ],

  // ── Microsoft services (scoped Graph API paths) ──
  // Use ** (deep glob) because Graph API paths are multi-segment
  // (e.g. /v1.0/me/messages/{id}/attachments/{aid})
  "microsoft-teams": [
    { baseUrl: "https://graph.microsoft.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1.0/me/chats/**",
      "/v1.0/chats/**",
      "/v1.0/teams/**",
      "/v1.0/me",
      "/v1.0/me/joinedTeams",
    ]},
  ],
  "microsoft-outlook-mail": [
    { baseUrl: "https://graph.microsoft.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1.0/me/messages/**",
      "/v1.0/me/mailFolders/**",
      "/v1.0/me/sendMail",
      "/v1.0/me",
    ]},
  ],
  "microsoft-outlook-calendar": [
    { baseUrl: "https://graph.microsoft.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1.0/me/events",
      "/v1.0/me/events/**",
      "/v1.0/me/calendar/events",
      "/v1.0/me/calendar/events/**",
      "/v1.0/me/calendars/**",
      "/v1.0/me/calendarView",
      "/v1.0/me/calendar/calendarView",
      "/v1.0/me/calendarGroups/**",
      "/v1.0/me",
    ]},
  ],
  "microsoft-onedrive": [
    { baseUrl: "https://graph.microsoft.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1.0/me/drive/**",
      "/v1.0/drives/**",
      "/v1.0/me",
    ]},
  ],
  "microsoft-outlook-contacts": [
    { baseUrl: "https://graph.microsoft.com", methods: [...ALL_METHODS], pathPatterns: [
      "/v1.0/me/contacts",
      "/v1.0/me/contacts/**",
      "/v1.0/me/contactFolders/**",
      "/v1.0/me/people",
      "/v1.0/me",
    ]},
  ],

  // ── Slack (all Web API methods) ──
  slack: [
    { baseUrl: "https://slack.com", methods: ["POST"], pathPatterns: ["/api/*"] },
  ],

  // ── Anthropic (Messages API) ──
  "anthropic-messages": [
    { baseUrl: "https://api.anthropic.com", methods: ["GET", "POST"], pathPatterns: ["/v1/messages", "/v1/models", "/v1/models/*"] },
  ],

  // ── OpenAI (Chat + Embeddings) ──
  openai: [
    { baseUrl: "https://api.openai.com", methods: ["GET", "POST"], pathPatterns: ["/v1/models", "/v1/models/*", "/v1/chat/completions", "/v1/responses", "/v1/embeddings"] },
  ],

  // ── Gemini (Generate + Embed + Batch) ──
  gemini: [
    {
      baseUrl: "https://generativelanguage.googleapis.com",
      methods: ["GET", "POST"],
      pathPatterns: [
        // Model discovery
        "/v1beta/models",
        "/v1beta/models/*",
        // Generation (streaming and non-streaming)
        "/v1beta/models/*:generateContent",
        "/v1beta/models/*:streamGenerateContent",
        // Token counting
        "/v1beta/models/*:countTokens",
        // Embeddings (single, batch, async batch)
        "/v1beta/models/*:embedContent",
        "/v1beta/models/*:batchEmbedContents",
        "/v1beta/models/*:asyncBatchEmbedContent",
        // Responses API
        "/v1beta/responses",
        "/v1beta/responses/*",
        // File upload for batch processing
        "/upload/v1beta/files*",
        "/upload/v1beta/files/*",
        "/upload/v1beta/files/*:download",
        // Batch operation tracking
        "/v1beta/batches/*",
      ],
    },
  ],

  // ── OpenRouter (OpenAI-compatible gateway) ──
  openrouter: [
    { baseUrl: "https://openrouter.ai", methods: ["GET", "POST"], pathPatterns: ["/api/v1/models", "/api/v1/models/*", "/api/v1/chat/completions"] },
  ],

  // ── Notion (all API endpoints) ──
  notion: [
    { baseUrl: "https://api.notion.com", methods: [...ALL_METHODS], pathPatterns: ["/v1/*"] },
  ],

  // ── Trello (all REST API v1 endpoints) ──
  trello: [
    { baseUrl: "https://api.trello.com", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/1/*"] },
  ],

  // ── Jira Cloud (REST API v3, variable base URL per connection) ──
  jira: [
    { baseUrl: "https://*.atlassian.net", methods: ["GET", "POST", "PUT", "DELETE"], pathPatterns: ["/rest/api/3/*"] },
  ],
};

/** Returns default allowlists for a service, or empty array if unknown. */
export function getDefaultAllowlistsForService(serviceId: string): AllowlistEntry[] {
  return SERVICE_DEFAULT_ALLOWLISTS[serviceId] ?? [];
}
