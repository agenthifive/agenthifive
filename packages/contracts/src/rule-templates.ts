import type { PolicyRules, RequestRule, ResponseRule } from "./policy.js";

// ── Types ─────────────────────────────────────────────────────────

export type RulePresetId = "minimal" | "standard" | "strict" | "custom";

export interface RulePreset {
  id: RulePresetId;
  name: string;
  description: string;
  /** The rules to apply when this preset is selected */
  rules: PolicyRules;
  /** Recommended legacy field values for backward-compatible behavior */
  recommended: {
    defaultMode: "read_only" | "read_write" | "custom";
    stepUpApproval: "always" | "risk_based" | "never";
  };
  /** Human-readable rate limit shown in preset cards (e.g., "100 req/hr") */
  rateLimitLabel?: string;
  /** Extra feature labels shown below the pills (e.g., "Approve full contact access") */
  features?: string[];
}

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  provider: string;
  /** Which preset tier this template belongs to */
  preset: RulePresetId;
  /** The individual rules this template contributes (merged into the preset) */
  requestRules: RequestRule[];
  responseRules: ResponseRule[];
}

// ── Common response rules (reusable across providers) ─────────────

export const PII_REDACT_RULE_LABEL = "Redact PII from all responses";
export const TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL = "Redact PII outside trusted recipient scope";

const PII_REDACT_RULE: ResponseRule = {
  label: PII_REDACT_RULE_LABEL,
  match: {},
  filter: {
    redact: [
      { type: "contact" },
      { type: "financial" },
      { type: "identity" },
    ],
  },
};

const TRUSTED_RECIPIENT_PII_REDACT_RULE: ResponseRule = {
  label: TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL,
  match: {},
  filter: {
    redact: [
      { type: "contact" },
      { type: "financial" },
      { type: "identity" },
    ],
  },
};

// ── Presets (provider-agnostic) ───────────────────────────────────

const MINIMAL_PRESET: Omit<RulePreset, "rules"> = {
  id: "minimal",
  name: "⚠️ Minimal Protection",
  description: "Read-only access with no approval requirements. No privacy filtering.",
  recommended: { defaultMode: "read_only", stepUpApproval: "never" },
};

const STANDARD_PRESET: Omit<RulePreset, "rules"> = {
  id: "standard",
  name: "🛡️ Balanced Protection",
  description: "Allow reads, require approval for writes. PII redacted.",
  recommended: { defaultMode: "read_write", stepUpApproval: "risk_based" },
};

const STRICT_PRESET: Omit<RulePreset, "rules"> = {
  id: "strict",
  name: "🔒 Strict Protection",
  description: "Allow reads, block deletes, require approval for all writes. PII redacted, sensitive fields stripped.",
  recommended: { defaultMode: "custom", stepUpApproval: "always" },
};

// ── Google Workspace ──────────────────────────────────────────────

function googlePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and list all files and folders. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read and list files. Public sharing is blocked. Binary downloads and write operations require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          {
            label: "Require approval for binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "require_approval",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          {
            label: "Block public sharing (anyone with link)",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "anyone" }],
            },
            action: "deny",
          },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read and list files. Public and organization-wide sharing are blocked. Binary downloads and deletion are blocked. All write operations require your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          {
            label: "Block binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "deny",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          {
            label: "Block public sharing (anyone with link)",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "anyone" }],
            },
            action: "deny",
          },
          {
            label: "Block organization-wide sharing",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "domain" }],
            },
            action: "deny",
          },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "/people/v1" },
            filter: {
              denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies"],
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

const GOOGLE_RULE_TEMPLATES: RuleTemplate[] = [
  // Gmail
  {
    id: "google-gmail-read-rules",
    name: "Gmail - Allow reading",
    description: "Allow reading messages and threads without approval",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages" }, action: "allow" },
      { label: "Allow reading threads", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/threads" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "google-gmail-send-approve",
    name: "Gmail - Approve sends",
    description: "Require approval for sending emails",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Approve email sends", match: { methods: ["POST"], urlPattern: "^/gmail/v1/users/me/messages/send$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "google-gmail-labels-allow",
    name: "Gmail - Allow label management",
    description: "Auto-approve creating and modifying labels",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Allow label management", match: { methods: ["POST", "PUT", "PATCH", "DELETE"], urlPattern: "^/gmail/v1/users/me/labels" }, action: "allow" },
    ],
    responseRules: [],
  },
  // Calendar
  {
    id: "google-calendar-read-rules",
    name: "Calendar - Allow reading",
    description: "Allow reading calendar events without approval",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Allow reading events", match: { methods: ["GET"], urlPattern: "^/calendar/v3" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "google-calendar-write-approve",
    name: "Calendar - Approve writes",
    description: "Require approval for creating or modifying events",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Approve event changes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"], urlPattern: "^/calendar/v3" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  // Drive
  {
    id: "google-drive-read-rules",
    name: "Drive - Allow reading",
    description: "Allow reading and listing files without approval",
    provider: "google",
    preset: "standard",
    requestRules: [
      { label: "Allow reading files", match: { methods: ["GET"], urlPattern: "^/drive/v3" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "google-drive-block-public",
    name: "Drive - Block public sharing",
    description: "Deny requests that share files publicly (type=anyone)",
    provider: "google",
    preset: "strict",
    requestRules: [
      {
        label: "Block public sharing (anyone with link)",
        match: {
          methods: ["POST"],
          urlPattern: "/drive/v3/.*/permissions",
          body: [{ path: "type", op: "eq", value: "anyone" }],
        },
        action: "deny",
      },
    ],
    responseRules: [],
  },
  // Drive - Block binary downloads
  {
    id: "google-drive-block-download",
    name: "Drive - Block binary downloads",
    description: "Block direct file downloads (alt=media) to enforce content filtering.",
    provider: "google",
    preset: "strict",
    requestRules: [
      {
        label: "Block binary file downloads",
        match: { methods: ["GET"], queryPattern: "alt=media" },
        action: "deny",
      },
    ],
    responseRules: [],
  },
  {
    id: "google-drive-approve-download",
    name: "Drive - Approve binary downloads",
    description: "Require approval for direct file downloads (alt=media). Direct download (bypasses PII filtering).",
    provider: "google",
    preset: "standard",
    requestRules: [
      {
        label: "Require approval for binary file downloads",
        match: { methods: ["GET"], queryPattern: "alt=media" },
        action: "require_approval",
      },
    ],
    responseRules: [],
  },
  // Contacts / People API
  {
    id: "google-contacts-strip-pii",
    name: "Contacts - Strip PII",
    description: "Remove phone numbers, addresses, and birthdays from contact responses",
    provider: "google",
    preset: "strict",
    requestRules: [],
    responseRules: [
      {
        label: "Strip contact PII",
        match: { urlPattern: "/people/v1" },
        filter: {
          denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies"],
          redact: [{ type: "email" }, { type: "phone" }],
        },
      },
    ],
  },
];

// ── Microsoft ─────────────────────────────────────────────────────

function microsoftPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and list all files and data. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read files and data. Binary file downloads and write operations require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          {
            label: "Require approval for binary file downloads",
            match: { methods: ["GET"], urlPattern: "/content$" },
            action: "require_approval",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read files and data. Binary downloads, external sharing, and deletion are blocked. All write operations require your approval. Personal information is redacted and directory details are stripped.",
      rules: {
        request: [
          {
            label: "Block binary file downloads",
            match: { methods: ["GET"], urlPattern: "/content$" },
            action: "deny",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          {
            label: "Block file sharing outside org",
            match: {
              methods: ["POST"],
              urlPattern: "/v1\\.0/drives/.*/items/.*/invite",
              body: [{ path: "requireSignIn", op: "eq", value: false }],
            },
            action: "deny",
          },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip user PII from directory",
            match: { urlPattern: "/v1\\.0/users" },
            filter: {
              denyFields: ["mobilePhone", "businessPhones", "streetAddress", "postalCode"],
              redact: [{ type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

const MICROSOFT_RULE_TEMPLATES: RuleTemplate[] = [
  // Teams Chat
  {
    id: "microsoft-chat-read-rules",
    name: "Teams - Allow reading chats",
    description: "Allow reading chat messages without approval",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Allow reading chats", match: { methods: ["GET"], urlPattern: "^/v1\\.0/(me/)?chats" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "microsoft-chat-send-approve",
    name: "Teams - Approve sending chat messages",
    description: "Require approval for sending chat messages",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Approve chat sends", match: { methods: ["POST"], urlPattern: "^/v1\\.0/(me/)?chats/.*/messages$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  // Teams Channels
  {
    id: "microsoft-channel-read-rules",
    name: "Teams - Allow reading channels",
    description: "Allow reading channel messages without approval",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Allow reading channels", match: { methods: ["GET"], urlPattern: "^/v1\\.0/teams/.*/channels" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "microsoft-channel-send-approve",
    name: "Teams - Approve channel posts",
    description: "Require approval for posting to channels",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Approve channel posts", match: { methods: ["POST"], urlPattern: "^/v1\\.0/teams/.*/channels/.*/messages$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  // Outlook Mail
  {
    id: "microsoft-mail-read-rules",
    name: "Outlook - Allow reading mail",
    description: "Allow reading emails without approval",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Allow reading mail", match: { methods: ["GET"], urlPattern: "^/v1\\.0/me/messages" }, action: "allow" },
      { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "^/v1\\.0/me/mailFolders" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "microsoft-mail-send-approve",
    name: "Outlook - Approve sending mail",
    description: "Require approval for sending emails",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Approve email sends", match: { methods: ["POST"], urlPattern: "^/v1\\.0/me/sendMail$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  // Calendar
  {
    id: "microsoft-calendar-read-rules",
    name: "Outlook Calendar - Allow reading",
    description: "Allow reading calendar events without approval",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Allow reading events", match: { methods: ["GET"], urlPattern: "^/v1\\.0/me/(calendar|events)" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "microsoft-calendar-write-approve",
    name: "Outlook Calendar - Approve writes",
    description: "Require approval for creating or modifying events",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      { label: "Approve event changes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"], urlPattern: "^/v1\\.0/me/(calendar|events)" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  // OneDrive - Block binary downloads
  {
    id: "microsoft-drive-block-download",
    name: "OneDrive - Block binary downloads",
    description: "Block direct file downloads (/content) to enforce content filtering.",
    provider: "microsoft",
    preset: "strict",
    requestRules: [
      {
        label: "Block binary file downloads",
        match: { methods: ["GET"], urlPattern: "/content$" },
        action: "deny",
      },
    ],
    responseRules: [],
  },
  {
    id: "microsoft-drive-approve-download",
    name: "OneDrive - Approve binary downloads",
    description: "Require approval for direct file downloads (/content). Direct download (bypasses PII filtering).",
    provider: "microsoft",
    preset: "standard",
    requestRules: [
      {
        label: "Require approval for binary file downloads",
        match: { methods: ["GET"], urlPattern: "/content$" },
        action: "require_approval",
      },
    ],
    responseRules: [],
  },
  // Directory
  {
    id: "microsoft-directory-strip-pii",
    name: "Directory - Strip PII",
    description: "Remove phone numbers and addresses from user directory responses",
    provider: "microsoft",
    preset: "strict",
    requestRules: [],
    responseRules: [
      {
        label: "Strip user PII from directory",
        match: { urlPattern: "/v1\\.0/users" },
        filter: {
          denyFields: ["mobilePhone", "businessPhones", "streetAddress", "postalCode"],
          redact: [{ type: "phone" }],
        },
      },
    ],
  },
];

// ── Telegram ──────────────────────────────────────────────────────

function telegramPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can send and receive messages, photos, and files. When a trusted list is set, only those contacts can interact. No approval required, no privacy filtering.",
      rules: {
        request: [
          { label: "Allow getUpdates", match: { methods: ["POST"], urlPattern: "/bot.*/getUpdates$" }, action: "allow" },
          { label: "Allow getMe", match: { methods: ["POST"], urlPattern: "/bot.*/getMe$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can receive messages. Sending messages, photos, and files requires your approval unless the recipient is on your trusted list. Personal information is automatically redacted outside your trusted list.",
      rules: {
        request: [
          { label: "Allow getUpdates", match: { methods: ["POST"], urlPattern: "/bot.*/getUpdates$" }, action: "allow" },
          { label: "Allow getMe", match: { methods: ["POST"], urlPattern: "/bot.*/getMe$" }, action: "allow" },
          { label: "Allow getChat", match: { methods: ["POST"], urlPattern: "/bot.*/getChat$" }, action: "allow" },
          { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/bot.*/sendMessage$" }, action: "require_approval" },
          { label: "Approve sending media", match: { methods: ["POST"], urlPattern: "/bot.*/send(Photo|Document|Video|Audio)$" }, action: "require_approval" },
        ],
        response: [TRUSTED_RECIPIENT_PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can receive messages. Sending text messages requires your approval unless the recipient is on your trusted list. Photos, files, and media are blocked. Forwarding, deleting, and editing are blocked. Personal information is redacted from responses.",
      rules: {
        request: [
          { label: "Allow getUpdates", match: { methods: ["POST"], urlPattern: "/bot.*/getUpdates$" }, action: "allow" },
          { label: "Allow getMe", match: { methods: ["POST"], urlPattern: "/bot.*/getMe$" }, action: "allow" },
          { label: "Allow getChat", match: { methods: ["POST"], urlPattern: "/bot.*/getChat$" }, action: "allow" },
          { label: "Block forwarding", match: { methods: ["POST"], urlPattern: "/bot.*/forward" }, action: "deny" },
          { label: "Block deleting messages", match: { methods: ["POST"], urlPattern: "/bot.*/deleteMessage$" }, action: "deny" },
          { label: "Block kicking members", match: { methods: ["POST"], urlPattern: "/bot.*/ban" }, action: "deny" },
          { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/bot.*/sendMessage$" }, action: "require_approval" },
          { label: "Approve sending media", match: { methods: ["POST"], urlPattern: "/bot.*/send(Photo|Document|Video|Audio)$" }, action: "require_approval" },
          { label: "Approve editing messages", match: { methods: ["POST"], urlPattern: "/bot.*/editMessage" }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const TELEGRAM_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "telegram-read-rules",
    name: "Telegram - Allow reading",
    description: "Allow getUpdates, getMe, and getChat without approval",
    provider: "telegram",
    preset: "standard",
    requestRules: [
      { label: "Allow getUpdates", match: { methods: ["POST"], urlPattern: "/bot.*/getUpdates$" }, action: "allow" },
      { label: "Allow getMe", match: { methods: ["POST"], urlPattern: "/bot.*/getMe$" }, action: "allow" },
      { label: "Allow getChat", match: { methods: ["POST"], urlPattern: "/bot.*/getChat$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "telegram-send-approve",
    name: "Telegram - Approve sending",
    description: "Require approval for sending messages and media",
    provider: "telegram",
    preset: "standard",
    requestRules: [
      { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/bot.*/sendMessage$" }, action: "require_approval" },
      { label: "Approve sending media", match: { methods: ["POST"], urlPattern: "/bot.*/send(Photo|Document|Video|Audio)$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "telegram-block-destructive",
    name: "Telegram - Block destructive actions",
    description: "Block forwarding, deleting messages, and banning members",
    provider: "telegram",
    preset: "strict",
    requestRules: [
      { label: "Block forwarding", match: { methods: ["POST"], urlPattern: "/bot.*/forward" }, action: "deny" },
      { label: "Block deleting messages", match: { methods: ["POST"], urlPattern: "/bot.*/deleteMessage$" }, action: "deny" },
      { label: "Block kicking members", match: { methods: ["POST"], urlPattern: "/bot.*/ban" }, action: "deny" },
    ],
    responseRules: [],
  },
];

// ── Slack ────────────────────────────────────────────────────────

function slackPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and send messages in any channel. No approval required, no privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow reading messages", match: { methods: ["POST"], urlPattern: "/api/conversations\\." }, action: "allow" },
          { label: "Allow listing users", match: { methods: ["POST"], urlPattern: "/api/users\\." }, action: "allow" },
          { label: "Allow listing emoji", match: { methods: ["POST"], urlPattern: "/api/emoji\\." }, action: "allow" },
          { label: "Allow listing pins", match: { methods: ["POST"], urlPattern: "/api/pins\\.list$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read messages in any channel. Sending messages and uploading files requires your approval. Personal information is automatically redacted outside your trusted list.",
      rules: {
        request: [
          { label: "Allow reading messages", match: { methods: ["POST"], urlPattern: "/api/conversations\\." }, action: "allow" },
          { label: "Allow listing users", match: { methods: ["POST"], urlPattern: "/api/users\\." }, action: "allow" },
          { label: "Allow listing emoji", match: { methods: ["POST"], urlPattern: "/api/emoji\\." }, action: "allow" },
          { label: "Allow listing pins", match: { methods: ["POST"], urlPattern: "/api/pins\\.list$" }, action: "allow" },
          { label: "Allow adding reactions", match: { methods: ["POST"], urlPattern: "/api/reactions\\.add$" }, action: "allow" },
          { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/api/chat\\.postMessage$" }, action: "require_approval" },
          { label: "Approve file uploads", match: { methods: ["POST"], urlPattern: "/api/files\\.uploadV2$" }, action: "require_approval" },
          { label: "Approve message edits", match: { methods: ["POST"], urlPattern: "/api/chat\\.update$" }, action: "require_approval" },
        ],
        response: [TRUSTED_RECIPIENT_PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read messages in any channel. Sending messages and files requires your approval. Message deletion and pin removal are blocked. Personal information is redacted from responses.",
      rules: {
        request: [
          { label: "Allow reading messages", match: { methods: ["POST"], urlPattern: "/api/conversations\\." }, action: "allow" },
          { label: "Allow listing users", match: { methods: ["POST"], urlPattern: "/api/users\\." }, action: "allow" },
          { label: "Allow listing emoji", match: { methods: ["POST"], urlPattern: "/api/emoji\\." }, action: "allow" },
          { label: "Allow listing pins", match: { methods: ["POST"], urlPattern: "/api/pins\\.list$" }, action: "allow" },
          { label: "Block message deletion", match: { methods: ["POST"], urlPattern: "/api/chat\\.delete$" }, action: "deny" },
          { label: "Block pin removal", match: { methods: ["POST"], urlPattern: "/api/pins\\.remove$" }, action: "deny" },
          { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/api/chat\\.postMessage$" }, action: "require_approval" },
          { label: "Approve file uploads", match: { methods: ["POST"], urlPattern: "/api/files\\.uploadV2$" }, action: "require_approval" },
          { label: "Approve message edits", match: { methods: ["POST"], urlPattern: "/api/chat\\.update$" }, action: "require_approval" },
          { label: "Approve adding reactions", match: { methods: ["POST"], urlPattern: "/api/reactions\\.(add|remove)$" }, action: "require_approval" },
          { label: "Approve pinning", match: { methods: ["POST"], urlPattern: "/api/pins\\.add$" }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const SLACK_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "slack-read-rules",
    name: "Slack - Allow reading",
    description: "Allow reading messages, channels, users, and threads without approval",
    provider: "slack",
    preset: "standard",
    requestRules: [
      { label: "Allow reading messages", match: { methods: ["POST"], urlPattern: "/api/conversations\\." }, action: "allow" },
      { label: "Allow listing users", match: { methods: ["POST"], urlPattern: "/api/users\\." }, action: "allow" },
      { label: "Allow listing emoji", match: { methods: ["POST"], urlPattern: "/api/emoji\\." }, action: "allow" },
      { label: "Allow listing pins", match: { methods: ["POST"], urlPattern: "/api/pins\\.list$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "slack-send-approve",
    name: "Slack - Approve sending",
    description: "Require approval for sending messages and uploading files",
    provider: "slack",
    preset: "standard",
    requestRules: [
      { label: "Approve sending messages", match: { methods: ["POST"], urlPattern: "/api/chat\\.postMessage$" }, action: "require_approval" },
      { label: "Approve file uploads", match: { methods: ["POST"], urlPattern: "/api/files\\.uploadV2$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "slack-block-destructive",
    name: "Slack - Block destructive actions",
    description: "Block message deletion and pin removal",
    provider: "slack",
    preset: "strict",
    requestRules: [
      { label: "Block message deletion", match: { methods: ["POST"], urlPattern: "/api/chat\\.delete$" }, action: "deny" },
      { label: "Block pin removal", match: { methods: ["POST"], urlPattern: "/api/pins\\.remove$" }, action: "deny" },
    ],
    responseRules: [],
  },
];

// ── Anthropic ────────────────────────────────────────────────────

/** Prompt injection: instruction override attempts */
const PROMPT_INJECTION_OVERRIDE_PATTERN =
  "(?i)(ignore\\s+(previous|all|prior|above|earlier|my|these|the)\\s+(instructions|prompts|rules|guidelines|context|directives|constraints)" +
  "|disregard\\s+(previous|all|your|prior|above|any)\\s+(instructions|prompts|rules|guidelines)" +
  "|forget\\s+(your|all|previous|prior|the)\\s+(instructions|rules|guidelines|prompt|context)" +
  "|override\\s+(your|all|the|system)\\s+(instructions|rules|prompt|guidelines)" +
  "|do\\s+not\\s+follow\\s+(your|the|any)\\s+(instructions|rules|guidelines|prompt))";

/** Prompt injection: delimiter/token injection */
const DELIMITER_INJECTION_PATTERN =
  "(<\\|endoftext\\|>|<\\|im_start\\|>|<\\|im_end\\|>|<\\/system>|\\[INST\\]|\\[\\/INST\\]|<<SYS>>|<\\|eot_id\\|>)";

function anthropicPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "Full API access with no restrictions. All models allowed, no token limits.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          { label: "Allow messages", match: { methods: ["POST"], urlPattern: "^/v1/messages$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "Allow messages, flag prompt injection and PII for approval. PII redacted.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Approve instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Approve delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Redact PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content", "system"],
              },
            },
            action: "redact",
            redactConfig: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["messages[*].content", "system"],
            },
          },
          { label: "Allow messages", match: { methods: ["POST"], urlPattern: "^/v1/messages$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "Block expensive models and prompt injection. Require approval for all messages. PII flagged and redacted.",
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Block Opus models",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "model", op: "contains", value: "opus" }],
            },
            action: "deny",
          },
          {
            label: "Block instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Block delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Approve PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content", "system"],
              },
            },
            action: "require_approval",
          },
          {
            label: "Approve very high max_tokens",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/messages$",
              body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
            },
            action: "require_approval",
          },
          { label: "Approve all messages", match: { methods: ["POST"], urlPattern: "^/v1/messages$" }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const ANTHROPIC_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "anthropic-messages-allow",
    name: "Anthropic - Allow messages",
    description: "Allow sending messages to Claude API",
    provider: "anthropic",
    preset: "standard",
    requestRules: [
      { label: "Allow messages", match: { methods: ["POST"], urlPattern: "^/v1/messages$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "anthropic-block-opus",
    name: "Anthropic - Block Opus models",
    description: "Deny requests targeting expensive Opus models",
    provider: "anthropic",
    preset: "strict",
    requestRules: [
      {
        label: "Block Opus models",
        match: {
          methods: ["POST"],
          urlPattern: "^/v1/messages$",
          body: [{ path: "model", op: "contains", value: "opus" }],
        },
        action: "deny",
      },
    ],
    responseRules: [],
  },
  {
    id: "anthropic-pii-prompt",
    name: "Anthropic - PII in prompts",
    description: "Redact sensitive PII from prompts before forwarding",
    provider: "anthropic",
    preset: "standard",
    requestRules: [
      { label: "Redact PII in prompts", match: { methods: ["POST"], urlPattern: "^/v1/messages$", pii: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content", "system"] } }, action: "redact", redactConfig: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content", "system"] } },
    ],
    responseRules: [],
  },
  {
    id: "anthropic-prompt-injection",
    name: "Anthropic - Prompt injection detection",
    description: "Detect common prompt injection patterns: instruction overrides and delimiter injection",
    provider: "anthropic",
    preset: "standard",
    requestRules: [
      { label: "Potential prompt injection: instruction override", match: { methods: ["POST"], urlPattern: "^/v1/messages$", body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }] }, action: "require_approval" },
      { label: "Potential prompt injection: delimiter/token injection", match: { methods: ["POST"], urlPattern: "^/v1/messages$", body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }] }, action: "require_approval" },
    ],
    responseRules: [],
  },
];

// ── OpenAI ───────────────────────────────────────────────────────

function openaiPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  const OPENAI_TEXT_GENERATION_URL = "^/v1/(chat/completions|responses)$";
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "Full API access with no restrictions. All models allowed, no token limits.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          { label: "Allow text generation", match: { methods: ["POST"], urlPattern: OPENAI_TEXT_GENERATION_URL }, action: "allow" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "Allow completions and embeddings, flag prompt injection for approval. PII redacted.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Approve instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Approve delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Redact PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content"],
              },
            },
            action: "redact",
            redactConfig: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["messages[*].content"],
            },
          },
          { label: "Allow text generation", match: { methods: ["POST"], urlPattern: OPENAI_TEXT_GENERATION_URL }, action: "allow" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "Block reasoning models and prompt injection. Require approval for all completions. PII flagged and redacted.",
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Block reasoning models (o-series)",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "model", op: "matches", value: "^o[0-9]" }],
            },
            action: "deny",
          },
          {
            label: "Block instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Block delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Approve PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content"],
              },
            },
            action: "require_approval",
          },
          {
            label: "Approve very high max_tokens",
            match: {
              methods: ["POST"],
              urlPattern: OPENAI_TEXT_GENERATION_URL,
              body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
            },
            action: "require_approval",
          },
          { label: "Approve all text generation", match: { methods: ["POST"], urlPattern: OPENAI_TEXT_GENERATION_URL }, action: "require_approval" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const OPENAI_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "openai-completions-allow",
    name: "OpenAI - Allow text generation",
    description: "Allow sending text generation requests to OpenAI chat or responses APIs",
    provider: "openai",
    preset: "standard",
    requestRules: [
      { label: "Allow text generation", match: { methods: ["POST"], urlPattern: "^/v1/(chat/completions|responses)$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "openai-embeddings-allow",
    name: "OpenAI - Allow embeddings",
    description: "Allow creating text embeddings",
    provider: "openai",
    preset: "standard",
    requestRules: [
      { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "openai-block-reasoning",
    name: "OpenAI - Block reasoning models",
    description: "Deny requests targeting expensive o-series reasoning models (o1, o3, o4)",
    provider: "openai",
    preset: "strict",
    requestRules: [
      {
        label: "Block reasoning models",
        match: {
          methods: ["POST"],
          urlPattern: "^/v1/(chat/completions|responses)$",
          body: [{ path: "model", op: "matches", value: "^o[0-9]" }],
        },
        action: "deny",
      },
    ],
    responseRules: [],
  },
  {
    id: "openai-pii-prompt",
    name: "OpenAI - PII in prompts",
    description: "Redact sensitive PII from prompts before forwarding",
    provider: "openai",
    preset: "standard",
    requestRules: [
      { label: "Redact PII in prompts", match: { methods: ["POST"], urlPattern: "^/v1/(chat/completions|responses)$", pii: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content"] } }, action: "redact", redactConfig: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content"] } },
    ],
    responseRules: [],
  },
  {
    id: "openai-prompt-injection",
    name: "OpenAI - Prompt injection detection",
    description: "Detect common prompt injection patterns: instruction overrides and delimiter injection",
    provider: "openai",
    preset: "standard",
    requestRules: [
      { label: "Potential prompt injection: instruction override", match: { methods: ["POST"], urlPattern: "^/v1/(chat/completions|responses)$", body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }] }, action: "require_approval" },
      { label: "Potential prompt injection: delimiter/token injection", match: { methods: ["POST"], urlPattern: "^/v1/(chat/completions|responses)$", body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }] }, action: "require_approval" },
    ],
    responseRules: [],
  },
];

// ── Gemini ───────────────────────────────────────────────────────

function geminiPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  const geminiGeneratePattern = ":(generate|streamGenerate)Content$";

  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "Full API access with no restrictions. All models allowed, no token limits.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1(beta)?/models$" }, action: "allow" },
          { label: "Allow generate content", match: { methods: ["POST"], urlPattern: geminiGeneratePattern }, action: "allow" },
          { label: "Allow embed content", match: { methods: ["POST"], urlPattern: ":embedContent$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "Allow content generation and embeddings, flag prompt injection for approval. PII redacted.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1(beta)?/models$" }, action: "allow" },
          {
            label: "Approve instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Approve delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Redact PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"],
              },
            },
            action: "redact",
            redactConfig: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"],
            },
          },
          { label: "Allow generate content", match: { methods: ["POST"], urlPattern: geminiGeneratePattern }, action: "allow" },
          { label: "Allow embed content", match: { methods: ["POST"], urlPattern: ":embedContent$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "Block prompt injection, require approval for all generation. PII flagged and redacted.",
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1(beta)?/models$" }, action: "allow" },
          {
            label: "Block instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Block delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Approve PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"],
              },
            },
            action: "require_approval",
          },
          {
            label: "Approve very high maxOutputTokens",
            match: {
              methods: ["POST"],
              urlPattern: geminiGeneratePattern,
              body: [{ path: "$body", op: "matches", value: "\"maxOutputTokens\"\\s*:\\s*\\d{5,}" }],
            },
            action: "require_approval",
          },
          { label: "Approve all content generation", match: { methods: ["POST"], urlPattern: geminiGeneratePattern }, action: "require_approval" },
          { label: "Allow embed content", match: { methods: ["POST"], urlPattern: ":embedContent$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const GEMINI_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "gemini-generate-allow",
    name: "Gemini - Allow content generation",
    description: "Allow sending content generation requests to Gemini models",
    provider: "gemini",
    preset: "standard",
    requestRules: [
      { label: "Allow generate content", match: { methods: ["POST"], urlPattern: ":(generate|streamGenerate)Content$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "gemini-embeddings-allow",
    name: "Gemini - Allow embeddings",
    description: "Allow creating text embeddings",
    provider: "gemini",
    preset: "standard",
    requestRules: [
      { label: "Allow embed content", match: { methods: ["POST"], urlPattern: ":embedContent$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "gemini-pii-prompt",
    name: "Gemini - PII in prompts",
    description: "Redact sensitive PII from prompts before forwarding",
    provider: "gemini",
    preset: "standard",
    requestRules: [
      { label: "Redact PII in prompts", match: { methods: ["POST"], urlPattern: ":(generate|streamGenerate)Content$", pii: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"] } }, action: "redact", redactConfig: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"] } },
    ],
    responseRules: [],
  },
  {
    id: "gemini-prompt-injection",
    name: "Gemini - Prompt injection detection",
    description: "Detect common prompt injection patterns: instruction overrides and delimiter injection",
    provider: "gemini",
    preset: "standard",
    requestRules: [
      { label: "Potential prompt injection: instruction override", match: { methods: ["POST"], urlPattern: ":(generate|streamGenerate)Content$", body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }] }, action: "require_approval" },
      { label: "Potential prompt injection: delimiter/token injection", match: { methods: ["POST"], urlPattern: ":(generate|streamGenerate)Content$", body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }] }, action: "require_approval" },
    ],
    responseRules: [],
  },
];

// ── OpenRouter ────────────────────────────────────────────────────
// OpenRouter is an OpenAI-compatible multi-model gateway. Same endpoint
// format (/v1/chat/completions, /v1/embeddings) but routes to many
// providers, so model-specific blocking rules are less useful.

function openrouterPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "Full API access with no restrictions. All models allowed, no token limits.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          { label: "Allow chat completions", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$" }, action: "allow" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "Allow completions and embeddings, flag prompt injection for approval. PII redacted.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Approve instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Approve delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "require_approval",
          },
          {
            label: "Redact PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content"],
              },
            },
            action: "redact",
            redactConfig: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["messages[*].content"],
            },
          },
          { label: "Allow chat completions", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$" }, action: "allow" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "Block prompt injection. Require approval for all completions. PII flagged and redacted.",
      rules: {
        request: [
          { label: "Allow list models", match: { methods: ["GET"], urlPattern: "^/v1/models" }, action: "allow" },
          {
            label: "Block instruction override injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              body: [{ path: "$body", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Block delimiter/token injection",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              body: [{ path: "$body", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
            },
            action: "deny",
          },
          {
            label: "Approve PII in prompts",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              pii: {
                types: [{ type: "us_ssn" }, { type: "credit_card" }],
                fields: ["messages[*].content"],
              },
            },
            action: "require_approval",
          },
          {
            label: "Approve very high max_tokens",
            match: {
              methods: ["POST"],
              urlPattern: "^/v1/chat/completions$",
              body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
            },
            action: "require_approval",
          },
          { label: "Approve all completions", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$" }, action: "require_approval" },
          { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const OPENROUTER_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "openrouter-completions-allow",
    name: "OpenRouter - Allow chat completions",
    description: "Allow sending chat completion requests via OpenRouter",
    provider: "openrouter",
    preset: "standard",
    requestRules: [
      { label: "Allow chat completions", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "openrouter-embeddings-allow",
    name: "OpenRouter - Allow embeddings",
    description: "Allow creating text embeddings via OpenRouter",
    provider: "openrouter",
    preset: "standard",
    requestRules: [
      { label: "Allow embeddings", match: { methods: ["POST"], urlPattern: "^/v1/embeddings$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "openrouter-pii-prompt",
    name: "OpenRouter - PII in prompts",
    description: "Redact sensitive PII from prompts before forwarding",
    provider: "openrouter",
    preset: "standard",
    requestRules: [
      { label: "Redact PII in prompts", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$", pii: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content"] } }, action: "redact", redactConfig: { types: [{ type: "us_ssn" }, { type: "credit_card" }], fields: ["messages[*].content"] } },
    ],
    responseRules: [],
  },
  {
    id: "openrouter-prompt-injection",
    name: "OpenRouter - Prompt injection detection",
    description: "Detect common prompt injection patterns: instruction overrides and delimiter injection",
    provider: "openrouter",
    preset: "standard",
    requestRules: [
      { label: "Potential prompt injection: instruction override", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$", body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }] }, action: "require_approval" },
      { label: "Potential prompt injection: delimiter/token injection", match: { methods: ["POST"], urlPattern: "^/v1/chat/completions$", body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }] }, action: "require_approval" },
    ],
    responseRules: [],
  },
];

// ── Notion ────────────────────────────────────────────────────────
// Notion uses POST for read operations (search, database query), so
// rule presets explicitly allow those POST patterns as reads.

function notionReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your pages, databases, and search content. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read and search your pages, databases, and blocks including individual page properties. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["Page property access"],
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read and search your pages, databases, and blocks. No individual property access. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["No individual property access"],
    },
  };
}

function notionManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, create, and update your pages and databases. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
          { label: "Allow all writes", match: { methods: ["POST", "PATCH", "PUT", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read and search your pages and databases. Creating and updating content requires your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
          { label: "Approve writes", match: { methods: ["POST", "PATCH", "PUT", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read and search your pages and databases. Deletion is blocked. All content creation and updates require your approval. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
          { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PATCH", "PUT"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const NOTION_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "notion-read-pages",
    name: "Notion - Allow reading pages",
    description: "Allow reading pages and their properties",
    provider: "notion",
    preset: "standard",
    requestRules: [
      { label: "Allow reading pages", match: { methods: ["GET"], urlPattern: "^/v1/pages" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "notion-read-blocks",
    name: "Notion - Allow reading blocks",
    description: "Allow reading block content and children",
    provider: "notion",
    preset: "standard",
    requestRules: [
      { label: "Allow reading blocks", match: { methods: ["GET"], urlPattern: "^/v1/blocks" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "notion-search",
    name: "Notion - Allow search",
    description: "Allow searching pages and databases (POST is a read operation)",
    provider: "notion",
    preset: "standard",
    requestRules: [
      { label: "Allow search", match: { methods: ["POST"], urlPattern: "^/v1/search$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "notion-query-db",
    name: "Notion - Allow database queries",
    description: "Allow querying databases with filters (POST is a read operation)",
    provider: "notion",
    preset: "standard",
    requestRules: [
      { label: "Allow database queries", match: { methods: ["POST"], urlPattern: "^/v1/databases/[^/]+/query$" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "notion-write-approve",
    name: "Notion - Approve writes",
    description: "Require approval for creating and updating pages and blocks",
    provider: "notion",
    preset: "standard",
    requestRules: [
      { label: "Approve page creation", match: { methods: ["POST"], urlPattern: "^/v1/pages$" }, action: "require_approval" },
      { label: "Approve page updates", match: { methods: ["PATCH"], urlPattern: "^/v1/pages/" }, action: "require_approval" },
      { label: "Approve block updates", match: { methods: ["PATCH"], urlPattern: "^/v1/blocks/" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "notion-delete-block",
    name: "Notion - Block deletion protection",
    description: "Block or require approval for deleting blocks",
    provider: "notion",
    preset: "strict",
    requestRules: [
      { label: "Block deletion of blocks", match: { methods: ["DELETE"], urlPattern: "^/v1/blocks/" }, action: "deny" },
    ],
    responseRules: [],
  },
  {
    id: "notion-pii-redact",
    name: "Notion - PII redaction",
    description: "Redact PII from all Notion API responses",
    provider: "notion",
    preset: "standard",
    requestRules: [],
    responseRules: [PII_REDACT_RULE],
  },
];

// ── Trello ─────────────────────────────────────────────────────────

function trelloReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your boards, lists, and cards. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your boards, lists, cards, and their details including attachments, checklists, and actions. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["Full card details and actions"],
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your boards, lists, and cards. No access to attachments, checklists, or card actions. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["No attachments, checklists, or card actions"],
    },
  };
}

function trelloManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your boards, create cards, update them, and manage lists. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow all writes", match: { methods: ["POST", "PUT", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your boards, create cards, update them, and add comments. Deletion and archiving require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow creating cards", match: { methods: ["POST"], urlPattern: "^/1/cards$" }, action: "allow" },
          { label: "Allow updating cards", match: { methods: ["PUT"], urlPattern: "^/1/cards/" }, action: "allow" },
          { label: "Allow adding comments", match: { methods: ["POST"], urlPattern: "^/1/cards/[^/]+/actions/comments$" }, action: "allow" },
          { label: "Approve deletes", match: { methods: ["DELETE"] }, action: "require_approval" },
          { label: "Approve archiving cards", match: { methods: ["PUT"], urlPattern: "^/1/cards/", body: [{ path: "closed", op: "eq", value: "true" }] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your boards. Deletion is blocked. Creating cards, updating them, and adding comments all require your approval. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve creating cards", match: { methods: ["POST"], urlPattern: "^/1/cards$" }, action: "require_approval" },
          { label: "Approve updating cards", match: { methods: ["PUT"], urlPattern: "^/1/cards/" }, action: "require_approval" },
          { label: "Approve adding comments", match: { methods: ["POST"], urlPattern: "^/1/cards/[^/]+/actions/comments$" }, action: "require_approval" },
          { label: "Approve creating lists", match: { methods: ["POST"], urlPattern: "^/1/lists$" }, action: "require_approval" },
          { label: "Approve all other writes", match: { methods: ["POST", "PUT"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const TRELLO_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "trello-read-boards",
    name: "Trello - Allow reading boards",
    description: "Allow reading boards, lists, and cards",
    provider: "trello",
    preset: "standard",
    requestRules: [
      { label: "Allow reading boards", match: { methods: ["GET"], urlPattern: "^/1/(boards|members)" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "trello-read-cards",
    name: "Trello - Allow reading cards",
    description: "Allow reading cards and their details",
    provider: "trello",
    preset: "standard",
    requestRules: [
      { label: "Allow reading cards", match: { methods: ["GET"], urlPattern: "^/1/(cards|lists)" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "trello-write-approve",
    name: "Trello - Approve writes",
    description: "Require approval for creating and updating cards",
    provider: "trello",
    preset: "standard",
    requestRules: [
      { label: "Approve card creation", match: { methods: ["POST"], urlPattern: "^/1/cards" }, action: "require_approval" },
      { label: "Approve card updates", match: { methods: ["PUT"], urlPattern: "^/1/cards/" }, action: "require_approval" },
      { label: "Approve comments", match: { methods: ["POST"], urlPattern: "^/1/cards/[^/]+/actions/comments" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "trello-delete-block",
    name: "Trello - Deletion protection",
    description: "Block or require approval for deleting resources",
    provider: "trello",
    preset: "strict",
    requestRules: [
      { label: "Block deletion of cards", match: { methods: ["DELETE"], urlPattern: "^/1/cards/" }, action: "deny" },
      { label: "Block deletion of boards", match: { methods: ["DELETE"], urlPattern: "^/1/boards/" }, action: "deny" },
    ],
    responseRules: [],
  },
  {
    id: "trello-pii-redact",
    name: "Trello - PII redaction",
    description: "Redact PII from all Trello API responses",
    provider: "trello",
    preset: "standard",
    requestRules: [],
    responseRules: [PII_REDACT_RULE],
  },
];

// ── Jira Cloud ────────────────────────────────────────────────────

function jiraReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your issues, projects, comments, and search users. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your issues, projects, comments, and search users. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["User search and profile access"],
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read issues and projects only. No access to user profiles or search. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
      features: ["No user search or profile access"],
    },
  };
}

function jiraManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and create issues, add comments, and manage projects. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow all writes", match: { methods: ["POST", "PUT", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read issues and create or update them. Workflow transitions and deletion require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow creating issues", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue$" }, action: "allow" },
          { label: "Allow updating issues", match: { methods: ["PUT"], urlPattern: "^/rest/api/3/issue/" }, action: "allow" },
          { label: "Allow adding comments", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/comment$" }, action: "allow" },
          { label: "Approve transitions", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/transitions$" }, action: "require_approval" },
          { label: "Approve deletes", match: { methods: ["DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your issues. Deletion is blocked. All issue creation, updates, comments, and workflow transitions require your approval. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve creating issues", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue$" }, action: "require_approval" },
          { label: "Approve updating issues", match: { methods: ["PUT"], urlPattern: "^/rest/api/3/issue/" }, action: "require_approval" },
          { label: "Approve adding comments", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/comment$" }, action: "require_approval" },
          { label: "Approve transitions", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/transitions$" }, action: "require_approval" },
          { label: "Approve all other writes", match: { methods: ["POST", "PUT"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

const JIRA_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "jira-read-issues",
    name: "Jira - Allow reading issues",
    description: "Allow searching and reading issues and comments",
    provider: "jira",
    preset: "standard",
    requestRules: [
      { label: "Allow reading issues", match: { methods: ["GET"], urlPattern: "^/rest/api/3/(search|issue)" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "jira-read-projects",
    name: "Jira - Allow reading projects",
    description: "Allow reading projects and their metadata",
    provider: "jira",
    preset: "standard",
    requestRules: [
      { label: "Allow reading projects", match: { methods: ["GET"], urlPattern: "^/rest/api/3/project" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "jira-write-approve",
    name: "Jira - Approve writes",
    description: "Require approval for creating and updating issues",
    provider: "jira",
    preset: "standard",
    requestRules: [
      { label: "Approve issue creation", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue" }, action: "require_approval" },
      { label: "Approve issue updates", match: { methods: ["PUT"], urlPattern: "^/rest/api/3/issue/" }, action: "require_approval" },
      { label: "Approve comments", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/comment" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "jira-transition-approve",
    name: "Jira - Approve transitions",
    description: "Require approval for workflow transitions",
    provider: "jira",
    preset: "strict",
    requestRules: [
      { label: "Approve transitions", match: { methods: ["POST"], urlPattern: "^/rest/api/3/issue/[^/]+/transitions" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "jira-delete-block",
    name: "Jira - Deletion protection",
    description: "Block or require approval for deleting issues",
    provider: "jira",
    preset: "strict",
    requestRules: [
      { label: "Block deletion of issues", match: { methods: ["DELETE"], urlPattern: "^/rest/api/3/issue/" }, action: "deny" },
    ],
    responseRules: [],
  },
  {
    id: "jira-pii-redact",
    name: "Jira - PII redaction",
    description: "Redact PII from all Jira API responses",
    provider: "jira",
    preset: "standard",
    requestRules: [],
    responseRules: [PII_REDACT_RULE],
  },
];

// ── Service-Specific Presets (Google) ────────────────────────────

/**
 * Gmail READ-ONLY presets - Email reading only (gmail.readonly scope)
 */
function gmailReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your emails, threads, attachments, and labels. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and threads. Attachments require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          // Attachment rule must come before the general messages rule (first-match wins)
          { label: "Approve reading attachments", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages/[^/]+/attachments" }, action: "require_approval" },
          { label: "Allow reading messages & threads", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/(messages|threads)" }, action: "allow" },
          { label: "Allow reading labels", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/labels" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can browse recent emails (last 7 days). Reading any email's content requires your approval. Attachments are blocked. Personal information is redacted.",
      rules: {
        request: [
          // newer_than:[1-7]d matches 1d–7d; handles both raw colon and URL-encoded %3A
          { label: "Browse recent emails (last 7 days)", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages", queryPattern: "newer_than(%3A|:)[1-7]d" }, action: "allow" },
          { label: "Approve reading email content", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages" }, action: "require_approval" },
          { label: "Allow reading labels", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/labels" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Gmail MANAGE presets - Read + Send + Compose (gmail.readonly + gmail.send + gmail.compose scopes)
 */
function gmailManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, send, and manage your emails with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and threads. Attachments, sending emails, creating drafts, and deletions require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Approve reading attachments", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages/[^/]+/attachments" }, action: "require_approval" },
          { label: "Allow reading messages & threads", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/(messages|threads)" }, action: "allow" },
          { label: "Allow reading labels", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/labels" }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can browse recent emails (last 7 days). Reading any email's content, sending emails, and creating drafts require your approval. Attachments and message deletion are blocked. Personal information is redacted.",
      rules: {
        request: [
          // newer_than:[1-7]d matches 1d–7d; handles both raw colon and URL-encoded %3A
          { label: "Browse recent emails (last 7 days)", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages", queryPattern: "newer_than(%3A|:)[1-7]d" }, action: "allow" },
          { label: "Approve reading email content", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/messages" }, action: "require_approval" },
          { label: "Allow reading labels", match: { methods: ["GET"], urlPattern: "^/gmail/v1/users/me/labels" }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Gmail presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use gmailReadPresets() or gmailManagePresets() based on granted scopes
 */
function gmailPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return gmailManagePresets();
}

/**
 * Google Calendar READ-ONLY presets - Calendar reading only (calendar.readonly scope)
 */
function calendarReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your calendar events and calendars. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your calendar events and attendee details. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can list your calendar events. Reading full event details including attendees requires your approval. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow listing events", match: { methods: ["GET"], urlPattern: "^/calendar/v3/calendars/[^/]+/events$" }, action: "allow" },
          { label: "Allow listing calendars", match: { methods: ["GET"], urlPattern: "^/calendar/v3/users/me/calendarList" }, action: "allow" },
          { label: "Approve reading event details", match: { methods: ["GET"], urlPattern: "^/calendar/v3/calendars/[^/]+/events/[^/]+" }, action: "require_approval" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Google Calendar MANAGE presets - Read + write events (calendar scope)
 */
function calendarManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, create, modify, and delete your calendar events with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your calendar events. Creating and modifying events requires your approval. Deleting events requires your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve event creation/updates", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
          { label: "Approve event deletion", match: { methods: ["DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your calendar events. All event creation and modifications require your approval. Event deletion is blocked. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block event deletion", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all event modifications", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Google Calendar-specific presets - defaults to manage presets
 * @deprecated Use calendarReadPresets() or calendarManagePresets() based on granted scopes
 */
function googleCalendarPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return calendarManagePresets();
}

/**
 * Google Drive READ-ONLY presets - File listing and reading (drive.readonly scope)
 */
function driveReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and list your files and folders. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read and list files. Binary file downloads require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          {
            label: "Approve binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "require_approval",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read and list files. Binary downloads are blocked. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          {
            label: "Block binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "deny",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "/people/v1" },
            filter: {
              denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies"],
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Drive MANAGE presets - Read + write files (drive scope)
 */
function driveManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, upload, and manage your files with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read and list files. Public sharing is blocked. Binary downloads and write operations require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          {
            label: "Require approval for binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "require_approval",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          {
            label: "Block public sharing (anyone with link)",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "anyone" }],
            },
            action: "deny",
          },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read and list files. Public and organization-wide sharing are blocked. Binary downloads and deletion are blocked. All write operations require your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          {
            label: "Block binary file downloads",
            match: { methods: ["GET"], queryPattern: "alt=media" },
            action: "deny",
          },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          {
            label: "Block public sharing (anyone with link)",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "anyone" }],
            },
            action: "deny",
          },
          {
            label: "Block organization-wide sharing",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/.*/permissions",
              body: [{ path: "type", op: "eq", value: "domain" }],
            },
            action: "deny",
          },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "/people/v1" },
            filter: {
              denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies"],
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Drive presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use driveReadPresets() or driveManagePresets() based on granted scopes
 */
function googleDrivePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return driveManagePresets();
}

/**
 * Google Docs READ-ONLY presets - Document reading (documents.readonly scope)
 */
function docsReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your documents. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your documents. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your documents. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Docs MANAGE presets - Read + edit documents (documents scope)
 */
function docsManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and edit your documents with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your documents. Creating documents and editing content require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve document creation", match: { methods: ["POST"], urlPattern: "^/v1/documents$" }, action: "require_approval" },
          { label: "Approve document edits", match: { methods: ["POST"], urlPattern: "^/v1/documents/[^/]+:batchUpdate" }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your documents. All edits and document creation require your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Docs presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use docsReadPresets() or docsManagePresets() based on granted scopes
 */
function googleDocsPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return docsManagePresets();
}

/**
 * Google Sheets READ-ONLY presets - Spreadsheet reading (spreadsheets.readonly scope)
 */
function sheetsReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your spreadsheets and cell values. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your spreadsheets and cell values. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can view spreadsheet structure. Reading cell values requires your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow spreadsheet metadata", match: { methods: ["GET"], urlPattern: "^/v4/spreadsheets/[^/]+$" }, action: "allow" },
          { label: "Approve reading cell values", match: { methods: ["GET"], urlPattern: "^/v4/spreadsheets/[^/]+/values" }, action: "require_approval" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Sheets MANAGE presets - Read + edit spreadsheets (spreadsheets scope)
 */
function sheetsManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and edit your spreadsheets with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your spreadsheets. Writing values, editing structure, and deletions require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve writing cell values", match: { methods: ["PUT"], urlPattern: "^/v4/spreadsheets/[^/]+/values" }, action: "require_approval" },
          { label: "Approve spreadsheet edits & creation", match: { methods: ["POST"] }, action: "require_approval" },
          { label: "Approve deletions", match: { methods: ["DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your spreadsheets. Deletions are blocked. Writing values and editing structure require your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletions", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve writing cell values", match: { methods: ["PUT"], urlPattern: "^/v4/spreadsheets/[^/]+/values" }, action: "require_approval" },
          { label: "Approve spreadsheet edits", match: { methods: ["POST"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Sheets presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use sheetsReadPresets() or sheetsManagePresets() based on granted scopes
 */
function googleSheetsPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return sheetsManagePresets();
}

// ── Service-Specific Presets (Microsoft) ─────────────────────────

/**
 * Microsoft Teams-specific presets - Chat and channel messages
 */
/**
 * Teams READ presets - Read-only access (Chat.Read scope)
 */
function teamsReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your Teams chats and channel messages. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your chats and channels. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your chats and channels. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Teams MANAGE presets - Read + Send + Manage (Chat.ReadWrite + ChatMessage.Send scopes)
 */
function teamsManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, send, and manage your Teams messages with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your chats and channels. Sending messages requires your approval. Personal information is automatically redacted outside trusted chats and channels.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve message sends", match: { methods: ["POST"], urlPattern: "/messages$" }, action: "require_approval" },
        ],
        response: [TRUSTED_RECIPIENT_PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your chats and channels. Message deletion is blocked. All message sends and channel writes require your approval. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block message deletion", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Teams presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use teamsReadPresets() or teamsManagePresets() based on granted scopes
 */
function microsoftTeamsPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return teamsManagePresets();
}

/**
 * Outlook Mail READ presets - Read-only access (Mail.Read scope)
 */
function outlookMailReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your emails, folders, and attachments. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and folders. Attachments require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          // Attachment access via direct URL (/messages/{id}/attachments)
          { label: "Approve reading attachments", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages/[^/]+/attachments" }, action: "require_approval" },
          // Attachment access via $expand=attachments on messages endpoint (matches both $expand and %24expand)
          { label: "Approve expanding attachments", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages", queryPattern: "(?i)(\\$|%24)expand=.*attachment" }, action: "require_approval" },
          { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages" }, action: "allow" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/mailFolders" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can browse recent emails (last 7 days). Reading any email's content requires your approval. Attachments are blocked. Personal information is redacted.",
      rules: {
        request: [
          // Microsoft Graph uses $filter=receivedDateTime ge ... for date filtering
          { label: "Browse recent emails (last 7 days)", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages", queryPattern: "receivedDateTime" }, action: "allow" },
          { label: "Approve reading email content", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages" }, action: "require_approval" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/mailFolders" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Outlook Mail MANAGE presets - Read + Send + Manage (Mail.Read + Mail.ReadWrite + Mail.Send scopes)
 */
function outlookMailManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, send, and manage your emails with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and folders. Attachments, sending emails, and deletions require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          // Attachment access via direct URL (/messages/{id}/attachments)
          { label: "Approve reading attachments", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages/[^/]+/attachments" }, action: "require_approval" },
          // Attachment access via $expand=attachments on messages endpoint (matches both $expand and %24expand)
          { label: "Approve expanding attachments", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages", queryPattern: "(?i)(\\$|%24)expand=.*attachment" }, action: "require_approval" },
          { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages" }, action: "allow" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/mailFolders" }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can browse recent emails (last 7 days). Reading any email's content, sending emails, and creating drafts require your approval. Attachments and message deletion are blocked. Personal information is redacted.",
      rules: {
        request: [
          { label: "Browse recent emails (last 7 days)", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages", queryPattern: "receivedDateTime" }, action: "allow" },
          { label: "Approve reading email content", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/messages" }, action: "require_approval" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/mailFolders" }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Outlook Mail presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use outlookMailReadPresets() or outlookMailManagePresets() based on granted scopes
 */
function outlookMailPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return outlookMailManagePresets();
}

/**
 * Outlook Calendar READ presets - Read-only access (Calendars.Read scope)
 */
function outlookCalendarReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your calendar events and calendars. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your calendar events and attendee details. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can list your calendar events. Reading full event details including attendees requires your approval. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow listing events", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)$" }, action: "allow" },
          { label: "Allow listing calendars", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/calendars" }, action: "allow" },
          { label: "Approve reading event details", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)/[^/]+" }, action: "require_approval" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Outlook Calendar MANAGE presets - Read + write events (Calendars.ReadWrite scope)
 */
function outlookCalendarManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, create, modify, and delete your calendar events with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your calendar events. Creating and modifying events requires your approval. Deleting events requires your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve event creation/updates", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
          { label: "Approve event deletion", match: { methods: ["DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can list your calendar events. Reading full event details and all modifications require your approval. Event deletion is blocked. Personal information is redacted and contact details are stripped.",
      rules: {
        request: [
          { label: "Allow listing events", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)$" }, action: "allow" },
          { label: "Allow listing calendars", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/calendars" }, action: "allow" },
          { label: "Approve reading event details", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)/[^/]+" }, action: "require_approval" },
          { label: "Block event deletion", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all event modifications", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip contact PII",
            match: { urlPattern: "." },
            filter: {
              redact: [{ type: "email" }, { type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Outlook Calendar presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use outlookCalendarReadPresets() or outlookCalendarManagePresets() based on granted scopes
 */
function outlookCalendarPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return outlookCalendarManagePresets();
}

/**
 * OneDrive READ presets - Read-only access (Files.Read scope)
 */
function oneDriveReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read and list your OneDrive files and folders. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your OneDrive files. Binary file downloads require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Approve binary file downloads", match: { methods: ["GET"], urlPattern: "/content$" }, action: "require_approval" },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your OneDrive file listings. Binary file downloads are blocked. Personal information is redacted and directory details are stripped.",
      rules: {
        request: [
          { label: "Block binary file downloads", match: { methods: ["GET"], urlPattern: "/content$" }, action: "deny" },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip user PII from directory",
            match: { urlPattern: "/v1\\.0/users" },
            filter: {
              denyFields: ["mobilePhone", "businessPhones", "streetAddress", "postalCode"],
              redact: [{ type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * OneDrive MANAGE presets - Read + write files (Files.ReadWrite scope)
 */
function oneDriveManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, upload, modify, and delete your OneDrive files with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your OneDrive files. Binary file downloads and write operations require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Approve binary file downloads", match: { methods: ["GET"], urlPattern: "/content$" }, action: "require_approval" },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your OneDrive files. Binary downloads, external sharing, and deletion are blocked. All write operations require your approval. Personal information is redacted and directory details are stripped.",
      rules: {
        request: [
          { label: "Block binary file downloads", match: { methods: ["GET"], urlPattern: "/content$" }, action: "deny" },
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          {
            label: "Block file sharing outside org",
            match: {
              methods: ["POST"],
              urlPattern: "/v1\\.0/drives/.*/items/.*/invite",
              body: [{ path: "requireSignIn", op: "eq", value: false }],
            },
            action: "deny",
          },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip user PII from directory",
            match: { urlPattern: "/v1\\.0/users" },
            filter: {
              denyFields: ["mobilePhone", "businessPhones", "streetAddress", "postalCode"],
              redact: [{ type: "phone" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * OneDrive presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use oneDriveReadPresets() or oneDriveManagePresets() based on granted scopes
 */
function oneDrivePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return oneDriveManagePresets();
}

/**
 * Google Contacts READ presets - Read-only access (contacts.readonly scope)
 */
function googleContactsReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your contacts. Notes and biographies are always stripped (may contain PINs, passwords, and other secrets).",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your contacts. Notes and sensitive fields (phone numbers, addresses, birthdays) are stripped. The agent can request full contact details (except notes) with your approval.",
      features: ["Approve full contact access"],
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your contacts. Notes are stripped and sensitive fields (phone numbers, addresses, birthdays) are permanently removed.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip sensitive contact fields",
            match: { urlPattern: "/v1/people" },
            filter: {
              denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies", "sipAddresses", "imClients", "locations", "externalIds", "events", "userDefined"],
              redact: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Google Contacts MANAGE presets - Read + write (contacts scope)
 */
function googleContactsManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, create, modify, and delete your contacts. Notes and biographies are always stripped (may contain PINs, passwords, and other secrets).",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your contacts. Notes and sensitive fields are stripped; the agent can request full contact details (except notes) with your approval. Creating or modifying contacts requires your approval.",
      features: ["Approve full contact access"],
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve contact modifications", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your contacts. Notes are stripped and sensitive fields (phone numbers, addresses, birthdays) are permanently removed. Deletion is blocked. All modifications require your approval.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block contact deletion", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip sensitive contact fields",
            match: { urlPattern: "/v1/people" },
            filter: {
              denyFields: ["phoneNumbers", "addresses", "birthdays", "biographies", "sipAddresses", "imClients", "locations", "externalIds", "events", "userDefined"],
              redact: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Outlook Contacts READ presets - Read-only access (Contacts.Read scope)
 */
function outlookContactsReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your contacts. Notes are always stripped (may contain PINs, passwords, and other secrets).",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your contacts. Notes and sensitive fields (phone numbers, addresses, birthdays) are stripped. The agent can request full contact details (except notes) with your approval.",
      features: ["Approve full contact access"],
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your contacts. Notes are stripped and sensitive fields (phone numbers, addresses, birthdays) are permanently removed.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [
          {
            label: "Strip sensitive contact fields",
            match: { urlPattern: "/v1\\.0/me/contacts" },
            filter: {
              denyFields: ["mobilePhone", "businessPhones", "homePhones", "homeAddress", "businessAddress", "otherAddress", "streetAddress", "postalCode", "personalNotes", "birthday", "spouseName", "children", "imAddresses"],
              redact: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Outlook Contacts MANAGE presets - Read + write (Contacts.ReadWrite scope)
 */
function outlookContactsManagePresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, create, modify, and delete your contacts. Notes are always stripped (may contain PINs, passwords, and other secrets).",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your contacts. Notes and sensitive fields are stripped; the agent can request full contact details (except notes) with your approval. Creating or modifying contacts requires your approval.",
      features: ["Approve full contact access"],
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve contact modifications", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can read your contacts. Notes are stripped and sensitive fields (phone numbers, addresses, birthdays) are permanently removed. Deletion is blocked. All modifications require your approval.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block contact deletion", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [
          {
            label: "Strip sensitive contact fields",
            match: { urlPattern: "/v1\\.0/me/contacts" },
            filter: {
              denyFields: ["mobilePhone", "businessPhones", "homePhones", "homeAddress", "businessAddress", "otherAddress", "streetAddress", "postalCode", "personalNotes", "birthday", "spouseName", "children", "imAddresses"],
              redact: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            },
          },
          PII_REDACT_RULE,
        ],
      },
    },
  };
}

/**
 * Outlook Contacts presets (legacy) - Defaults to manage presets for backwards compatibility
 * @deprecated Use outlookContactsReadPresets() or outlookContactsManagePresets() based on granted scopes
 */
function outlookContactsPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return outlookContactsManagePresets();
}

// ── Exports ───────────────────────────────────────────────────────

/** All rule presets indexed by provider (DEPRECATED - use RULE_PRESETS_BY_SERVICE) */
export const RULE_PRESETS: Record<string, Record<Exclude<RulePresetId, "custom">, RulePreset>> = {
  google: googlePresets(),
  microsoft: microsoftPresets(),
  telegram: telegramPresets(),
  slack: slackPresets(),
  anthropic: anthropicPresets(),
  openai: openaiPresets(),
  gemini: geminiPresets(),
  openrouter: openrouterPresets(),
  notion: notionManagePresets(),
  trello: trelloManagePresets(),
  jira: jiraManagePresets(),
};

/** All individual rule templates indexed by provider */
const EMAIL_RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: "email-read-rules",
    name: "Email - Allow reading",
    description: "Allow reading messages, folders, and message content without approval",
    provider: "email",
    preset: "standard",
    requestRules: [
      { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "^/messages" }, action: "allow" },
      { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "^/folders" }, action: "allow" },
    ],
    responseRules: [],
  },
  {
    id: "email-send-approve",
    name: "Email - Approve sends",
    description: "Require approval for sending, replying, and forwarding emails",
    provider: "email",
    preset: "standard",
    requestRules: [
      { label: "Approve sending", match: { methods: ["POST"], urlPattern: "^/messages/send$" }, action: "require_approval" },
      { label: "Approve replies", match: { methods: ["POST"], urlPattern: "^/messages/[^/]+/reply$" }, action: "require_approval" },
      { label: "Approve forwards", match: { methods: ["POST"], urlPattern: "^/messages/[^/]+/forward$" }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "email-delete-approve",
    name: "Email - Approve deletes",
    description: "Require approval for deleting or trashing messages",
    provider: "email",
    preset: "standard",
    requestRules: [
      { label: "Approve deletes", match: { methods: ["DELETE"] }, action: "require_approval" },
    ],
    responseRules: [],
  },
  {
    id: "email-attachment-approve",
    name: "Email - Approve attachments",
    description: "Require approval before downloading email attachments",
    provider: "email",
    preset: "strict",
    requestRules: [
      { label: "Approve attachments", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+/attachments" }, action: "require_approval" },
    ],
    responseRules: [],
  },
];

export const RULE_TEMPLATES: Record<string, RuleTemplate[]> = {
  google: GOOGLE_RULE_TEMPLATES,
  microsoft: MICROSOFT_RULE_TEMPLATES,
  telegram: TELEGRAM_RULE_TEMPLATES,
  slack: SLACK_RULE_TEMPLATES,
  anthropic: ANTHROPIC_RULE_TEMPLATES,
  openai: OPENAI_RULE_TEMPLATES,
  gemini: GEMINI_RULE_TEMPLATES,
  openrouter: OPENROUTER_RULE_TEMPLATES,
  notion: NOTION_RULE_TEMPLATES,
  trello: TRELLO_RULE_TEMPLATES,
  jira: JIRA_RULE_TEMPLATES,
  email: EMAIL_RULE_TEMPLATES,
};

// ─────────────────────────────────────────────────────────────────
// Email (IMAP/SMTP) presets
// ─────────────────────────────────────────────────────────────────

/**
 * Email IMAP presets — uses virtual URL paths (email-imap.internal/...)
 * Modeled on Gmail manage presets but adapted for the IMAP REST translation layer.
 */
/**
 * Email IMAP READ-ONLY presets — read messages and folders only
 */
function emailImapReadPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read your emails and folders. No privacy filtering.",
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and folders. Attachments require approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Approve attachments", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+/attachments" }, action: "require_approval" },
          { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "^/messages" }, action: "allow" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "^/folders" }, action: "allow" },
          { label: "Block everything else", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can list folders and browse message subjects. Reading full message content requires approval. Attachments are blocked. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow listing folders", match: { methods: ["GET"], urlPattern: "^/folders$" }, action: "allow" },
          { label: "Allow listing messages", match: { methods: ["GET"], urlPattern: "^/messages$" }, action: "allow" },
          { label: "Approve reading message content", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+" }, action: "require_approval" },
          { label: "Block attachments", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+/attachments" }, action: "deny" },
          { label: "Block everything else", match: { methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] }, action: "deny" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Email IMAP MANAGE presets — read + send + manage emails
 */
function emailImapPresets(): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: {
      ...MINIMAL_PRESET,
      description: "The agent can read, send, and manage your emails with no restrictions. No privacy filtering.",
      recommended: { defaultMode: "read_write", stepUpApproval: "never" },
      rules: {
        request: [
          { label: "Allow all reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Allow writes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "allow" },
        ],
        response: [],
      },
    },
    standard: {
      ...STANDARD_PRESET,
      description: "The agent can read your emails and folders. Sending emails, moving/deleting messages, and downloading attachments require your approval. Personal information is automatically redacted.",
      rules: {
        request: [
          { label: "Approve attachments", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+/attachments" }, action: "require_approval" },
          { label: "Allow reading messages", match: { methods: ["GET"], urlPattern: "^/messages" }, action: "allow" },
          { label: "Allow reading folders", match: { methods: ["GET"], urlPattern: "^/folders" }, action: "allow" },
          { label: "Approve sending", match: { methods: ["POST"], urlPattern: "^/messages/send" }, action: "require_approval" },
          { label: "Approve reply/forward", match: { methods: ["POST"], urlPattern: "^/messages/[^/]+/(reply|forward)" }, action: "require_approval" },
          { label: "Approve move/copy/delete", match: { methods: ["POST", "PATCH", "DELETE"], urlPattern: "^/messages/[^/]+/(move|copy|flags)" }, action: "require_approval" },
          { label: "Approve deletes", match: { methods: ["DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      description: "The agent can list folders and browse message subjects. Reading full message content requires approval. Sending, replying, and deleting are blocked. Personal information is redacted.",
      rules: {
        request: [
          { label: "Allow listing folders", match: { methods: ["GET"], urlPattern: "^/folders$" }, action: "allow" },
          { label: "Allow listing messages", match: { methods: ["GET"], urlPattern: "^/messages$" }, action: "allow" },
          { label: "Approve reading message content", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+" }, action: "require_approval" },
          { label: "Block attachments", match: { methods: ["GET"], urlPattern: "^/messages/[^/]+/attachments" }, action: "deny" },
          { label: "Block sending", match: { methods: ["POST"], urlPattern: "^/messages/send" }, action: "deny" },
          { label: "Block reply/forward", match: { methods: ["POST"], urlPattern: "^/messages/[^/]+/(reply|forward)" }, action: "deny" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all other writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// Rate-limit labels (shown in preset cards)
// ─────────────────────────────────────────────────────────────────

/** Stamp rateLimitLabel onto a preset map. Values from policy-generator getRateLimitsForAction(). */
function withRateLimits(
  presets: Record<Exclude<RulePresetId, "custom">, RulePreset>,
  labels: { minimal: string; standard: string; strict: string },
): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return {
    minimal: { ...presets.minimal, rateLimitLabel: labels.minimal },
    standard: { ...presets.standard, rateLimitLabel: labels.standard },
    strict: { ...presets.strict, rateLimitLabel: labels.strict },
  };
}

// Rate limit labels per service category (mirrors getRateLimitsForAction in policy-generator.ts)
const LLM_RATES    = { minimal: "500 req/hr", standard: "100 req/hr", strict: "20 req/hr" };
const TG_SLACK     = { minimal: "1,000 req/hr", standard: "200 req/hr", strict: "30 req/hr" };
const READ_RATES   = { minimal: "1,000 req/hr", standard: "200 req/hr", strict: "50 req/hr" };
const WRITE_RATES  = { minimal: "500 req/hr", standard: "100 req/hr", strict: "25 req/hr" };

// ─────────────────────────────────────────────────────────────────
// Service-Specific Rule Presets (NEW)
// ─────────────────────────────────────────────────────────────────

/**
 * All rule presets indexed by serviceId.
 * Replaces provider-level RULE_PRESETS for better service specificity.
 */
export const RULE_PRESETS_BY_SERVICE: Record<string, Record<Exclude<RulePresetId, "custom">, RulePreset>> = {
  // Google services
  "google-gmail": withRateLimits(gmailPresets(), READ_RATES),
  "google-calendar": withRateLimits(calendarManagePresets(), WRITE_RATES),
  "google-drive": withRateLimits(driveManagePresets(), WRITE_RATES),
  "google-docs": withRateLimits(docsManagePresets(), READ_RATES),
  "google-sheets": withRateLimits(sheetsManagePresets(), READ_RATES),
  // Microsoft services
  "microsoft-teams": withRateLimits(teamsManagePresets(), WRITE_RATES),
  "microsoft-outlook-mail": withRateLimits(outlookMailManagePresets(), READ_RATES),
  "microsoft-outlook-calendar": withRateLimits(outlookCalendarManagePresets(), READ_RATES),
  "microsoft-onedrive": withRateLimits(oneDriveManagePresets(), READ_RATES),
  "microsoft-outlook-contacts": withRateLimits(outlookContactsManagePresets(), READ_RATES),
  "google-contacts": withRateLimits(googleContactsManagePresets(), READ_RATES),
  // Messaging
  telegram: withRateLimits(telegramPresets(), TG_SLACK),
  slack: withRateLimits(slackPresets(), TG_SLACK),
  // LLM providers
  "anthropic-messages": withRateLimits(anthropicPresets(), LLM_RATES),
  openai: withRateLimits(openaiPresets(), LLM_RATES),
  gemini: withRateLimits(geminiPresets(), LLM_RATES),
  openrouter: withRateLimits(openrouterPresets(), LLM_RATES),
  // Productivity
  notion: withRateLimits(notionManagePresets(), READ_RATES),
  trello: withRateLimits(trelloManagePresets(), READ_RATES),
  jira: withRateLimits(jiraManagePresets(), READ_RATES),
  // Email (IMAP/SMTP)
  "email-imap": withRateLimits(emailImapPresets(), READ_RATES),
};

/**
 * Get presets for a service based on granted OAuth scopes
 * @param serviceId - The service ID (e.g., "google-gmail")
 * @param grantedScopes - Array of OAuth scopes granted to the connection
 * @returns Scope-aware presets (read-only vs read-write)
 */
export function getPresetsForScopes(
  serviceId: string,
  grantedScopes: string[],
): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  // Check if scopes include write capabilities
  const hasWriteScopes = grantedScopes.some(scope =>
    scope.includes('send') ||
    scope.includes('write') ||
    scope.includes('modify') ||
    scope.includes('compose') ||
    scope.includes('ReadWrite') ||
    scope.includes('Send')
  );

  // Gmail: Check for read-only vs manage
  if (serviceId === "google-gmail") {
    return hasWriteScopes ? gmailManagePresets() : gmailReadPresets();
  }

  // Google Calendar: Check for read-only vs manage
  if (serviceId === "google-calendar") {
    const hasCalendarWriteScope = grantedScopes.some(scope =>
      scope.includes("calendar") && !scope.includes("readonly")
    );
    return hasCalendarWriteScope ? calendarManagePresets() : calendarReadPresets();
  }

  // Google Drive: Check for read-only vs manage
  if (serviceId === "google-drive") {
    const hasDriveWriteScope = grantedScopes.some(scope =>
      scope.includes("drive") && !scope.includes("readonly") && !scope.includes("metadata")
    );
    return hasDriveWriteScope ? driveManagePresets() : driveReadPresets();
  }

  // Google Docs: Check for read-only vs manage
  if (serviceId === "google-docs") {
    const hasDocsWriteScope = grantedScopes.some(scope =>
      scope.includes("documents") && !scope.includes("readonly")
    );
    return hasDocsWriteScope ? docsManagePresets() : docsReadPresets();
  }

  // Google Sheets: Check for read-only vs manage
  if (serviceId === "google-sheets") {
    const hasSheetsWriteScope = grantedScopes.some(scope =>
      scope.includes("spreadsheets") && !scope.includes("readonly")
    );
    return hasSheetsWriteScope ? sheetsManagePresets() : sheetsReadPresets();
  }

  // Microsoft Outlook Mail: Check for read-only vs manage
  if (serviceId === "microsoft-outlook-mail") {
    return hasWriteScopes ? outlookMailManagePresets() : outlookMailReadPresets();
  }

  // Microsoft Teams: Check for read-only vs manage
  if (serviceId === "microsoft-teams") {
    return hasWriteScopes ? teamsManagePresets() : teamsReadPresets();
  }

  // Microsoft Outlook Calendar: Check for read-only vs manage
  if (serviceId === "microsoft-outlook-calendar") {
    return hasWriteScopes ? outlookCalendarManagePresets() : outlookCalendarReadPresets();
  }

  // Microsoft OneDrive: Check for read-only vs manage
  if (serviceId === "microsoft-onedrive") {
    return hasWriteScopes ? oneDriveManagePresets() : oneDriveReadPresets();
  }

  // Microsoft Outlook Contacts: Check for read-only vs manage
  if (serviceId === "microsoft-outlook-contacts") {
    return hasWriteScopes ? outlookContactsManagePresets() : outlookContactsReadPresets();
  }

  // Google Contacts: Check for read-only vs manage
  // The write scope is just "contacts" (no 'write'/'modify' keyword), so use a service-specific check
  if (serviceId === "google-contacts") {
    const hasContactsWriteScope = grantedScopes.some(scope =>
      scope.includes("contacts") && !scope.includes("readonly")
    );
    return hasContactsWriteScope ? googleContactsManagePresets() : googleContactsReadPresets();
  }

  // For other services, use standard service-level presets
  return getPresetsForService(serviceId);
}

/** Get presets for a service, with fallback to generic presets */
export function getPresetsForService(
  serviceId: string,
): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return RULE_PRESETS_BY_SERVICE[serviceId] ?? {
    minimal: {
      ...MINIMAL_PRESET,
      rules: { request: [{ label: "Allow reads", match: { methods: ["GET"] }, action: "allow" }], response: [] },
    },
    standard: {
      ...STANDARD_PRESET,
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/**
 * Get presets based on an action template ID (e.g., "notion-read" vs "notion-manage").
 * Returns null if no action-template-specific presets exist (caller should fall back
 * to scope-aware or service-level presets).
 */
export function getPresetsForActionTemplate(
  actionTemplateId: string,
): Record<Exclude<RulePresetId, "custom">, RulePreset> | null {
  const ACTION_TEMPLATE_PRESETS: Record<string, () => Record<Exclude<RulePresetId, "custom">, RulePreset>> = {
    // Google
    "gmail-read": gmailReadPresets,
    "gmail-manage": gmailManagePresets,
    "calendar-read": calendarReadPresets,
    "calendar-manage": calendarManagePresets,
    "drive-read": driveReadPresets,
    "drive-manage": driveManagePresets,
    "docs-read": docsReadPresets,
    "docs-manage": docsManagePresets,
    "sheets-read": sheetsReadPresets,
    "sheets-manage": sheetsManagePresets,
    "contacts-read": googleContactsReadPresets,
    "contacts-manage": googleContactsManagePresets,
    // Microsoft
    "teams-read": teamsReadPresets,
    "teams-manage": teamsManagePresets,
    "outlook-read": outlookMailReadPresets,
    "outlook-manage": outlookMailManagePresets,
    "outlook-calendar-read": outlookCalendarReadPresets,
    "outlook-calendar-manage": outlookCalendarManagePresets,
    "onedrive-read": oneDriveReadPresets,
    "onedrive-manage": oneDriveManagePresets,
    "outlook-contacts-read": outlookContactsReadPresets,
    "outlook-contacts-manage": outlookContactsManagePresets,
    // Messaging
    telegram: telegramPresets,
    slack: slackPresets,
    // LLM providers
    "anthropic-messages": anthropicPresets,
    openai: openaiPresets,
    gemini: geminiPresets,
    openrouter: openrouterPresets,
    // Productivity
    "notion-read": notionReadPresets,
    "notion-manage": notionManagePresets,
    "trello-read": trelloReadPresets,
    "trello-manage": trelloManagePresets,
    "jira-read": jiraReadPresets,
    "jira-manage": jiraManagePresets,
    // Email (IMAP/SMTP)
    "email-read": emailImapReadPresets,
    "email-manage": emailImapPresets,
  };
  const factory = ACTION_TEMPLATE_PRESETS[actionTemplateId];
  return factory ? factory() : null;
}

// ─────────────────────────────────────────────────────────────────
// DEPRECATED: Provider-Level Presets
// ─────────────────────────────────────────────────────────────────

/**
 * @deprecated Use getPresetsForService() instead - provides better service-specific rules
 * Get presets for a provider, with fallback to generic presets
 */
export function getPresetsForProvider(
  provider: string,
): Record<Exclude<RulePresetId, "custom">, RulePreset> {
  return RULE_PRESETS[provider] ?? {
    minimal: {
      ...MINIMAL_PRESET,
      rules: { request: [{ label: "Allow reads", match: { methods: ["GET"] }, action: "allow" }], response: [] },
    },
    standard: {
      ...STANDARD_PRESET,
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Approve writes & deletes", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
    strict: {
      ...STRICT_PRESET,
      rules: {
        request: [
          { label: "Allow reads", match: { methods: ["GET"] }, action: "allow" },
          { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          { label: "Approve all writes", match: { methods: ["POST", "PUT", "PATCH"] }, action: "require_approval" },
        ],
        response: [PII_REDACT_RULE],
      },
    },
  };
}

/** Get individual rule templates for a provider */
export function getTemplatesForProvider(provider: string): RuleTemplate[] {
  return RULE_TEMPLATES[provider] ?? [];
}
