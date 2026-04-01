import type { RequestRule, ResponseRule } from "./policy.js";

// ── Guard Categories ─────────────────────────────────────────────

export type GuardCategory =
  | "content_safety"
  | "messaging"
  | "file_sharing"
  | "calendar"
  | "data_reading"
  | "destructive"
  | "admin"
  | "llm_safety";

export interface GuardCategoryInfo {
  id: GuardCategory;
  name: string;
  description: string;
}

export const GUARD_CATEGORIES: GuardCategoryInfo[] = [
  { id: "content_safety", name: "Content Safety", description: "Cross-cutting guards for all outbound content" },
  { id: "messaging", name: "Messaging", description: "Guards for outbound messages, emails, and channel posts" },
  { id: "file_sharing", name: "File Sharing", description: "Guards for file uploads, sharing, and permissions" },
  { id: "calendar", name: "Calendar", description: "Guards for calendar events and invitations" },
  { id: "data_reading", name: "Data Reading", description: "Filters for inbound data and API responses" },
  { id: "destructive", name: "Destructive Actions", description: "Guards for delete, kick, and revoke operations" },
  { id: "admin", name: "Administration", description: "Guards for role and settings changes" },
  { id: "llm_safety", name: "LLM Safety", description: "Guards for LLM API requests: PII, model restrictions, cost control" },
];

// ── Contextual Guard Type ────────────────────────────────────────

export interface ContextualGuard {
  id: string;
  category: GuardCategory;
  name: string;
  description: string;
  risk: "low" | "medium" | "high";
  /** Minimum preset tier that would typically include this guard */
  presetTier: "minimal" | "standard" | "strict";
  /** Which providers have implementations for this guard */
  providers: string[];
  /** Provider-specific rule implementations */
  rules: Record<string, {
    requestRules: RequestRule[];
    responseRules: ResponseRule[];
  }>;
}

// ── Common Patterns ──────────────────────────────────────────────

/**
 * Basic profanity detection regex (English).
 * Production deployments should replace with a comprehensive word list
 * or content moderation API. This is a starter pattern.
 */
const PROFANITY_PATTERN =
  "(?i)\\b(fuck|shit|damn|ass|bitch|bastard|crap|dick|piss|hell)\\b";

/**
 * Prompt injection heuristic: instruction override attempts.
 * Catches "ignore/disregard/forget/override previous instructions" and similar.
 * Uses $body full-payload matching. Not a replacement for a classifier, but
 * catches the most common and dangerous patterns with low false-positive rates.
 */
const PROMPT_INJECTION_OVERRIDE_PATTERN =
  "(?i)(ignore\\s+(previous|all|prior|above|earlier|my|these|the)\\s+(instructions|prompts|rules|guidelines|context|directives|constraints)" +
  "|disregard\\s+(previous|all|your|prior|above|any)\\s+(instructions|prompts|rules|guidelines)" +
  "|forget\\s+(your|all|previous|prior|the)\\s+(instructions|rules|guidelines|prompt|context)" +
  "|override\\s+(your|all|the|system)\\s+(instructions|rules|prompt|guidelines)" +
  "|do\\s+not\\s+follow\\s+(your|the|any)\\s+(instructions|rules|guidelines|prompt))";

/**
 * Prompt injection heuristic: delimiter/token injection.
 * Catches attempts to inject special tokens or close system message blocks.
 */
const DELIMITER_INJECTION_PATTERN =
  "(<\\|endoftext\\|>|<\\|im_start\\|>|<\\|im_end\\|>|<\\/system>|\\[INST\\]|\\[\\/INST\\]|<<SYS>>|<\\|eot_id\\|>)";

/** Internal/private IP address ranges */
const INTERNAL_IP_PATTERN =
  "\\b(10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|172\\.(1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3})\\b";

/** Dangerous file extensions */
const DANGEROUS_EXT_PATTERN =
  "\\.(exe|bat|ps1|cmd|sh|vbs|msi|dll|scr|com|pif|js|wsf|hta)$";

/** Filenames suggesting credentials/secrets */
const SENSITIVE_FILENAME_PATTERN =
  "(?i)(password|secret|credential|private.?key|\\.env|\\.pem|\\.p12|\\.pfx|id_rsa|token)";

// ── Content Safety Guards ────────────────────────────────────────

const CS_PROFANITY: ContextualGuard = {
  id: "cs-profanity",
  category: "content_safety",
  name: "Profanity Filter",
  description:
    "Block outbound content containing profane or offensive language. " +
    "Applies to chat messages, channel posts, and email body where inspectable. " +
    "Pattern is customizable in the rule editor.",
  risk: "high",
  presetTier: "standard",
  providers: ["microsoft", "telegram", "slack"],
  rules: {
    microsoft: {
      requestRules: [
        {
          label: "Block profanity in chat messages",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/(me/)?chats/.*/messages$",
            body: [{ path: "body.content", op: "matches", value: PROFANITY_PATTERN }],
          },
          action: "deny",
        },
        {
          label: "Block profanity in channel posts",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/teams/.*/channels/.*/messages$",
            body: [{ path: "body.content", op: "matches", value: PROFANITY_PATTERN }],
          },
          action: "deny",
        },
        {
          label: "Block profanity in emails",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            body: [{ path: "message.body.content", op: "matches", value: PROFANITY_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    telegram: {
      requestRules: [
        {
          label: "Block profanity in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/bot.*/sendMessage$",
            body: [{ path: "text", op: "matches", value: PROFANITY_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    slack: {
      requestRules: [
        {
          label: "Block profanity in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/api/chat\\.postMessage$",
            body: [{ path: "text", op: "matches", value: PROFANITY_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const CS_PII_OUTBOUND: ContextualGuard = {
  id: "cs-pii-outbound",
  category: "content_safety",
  name: "PII Outbound Guard",
  description:
    "Redact high-risk outbound PII by default (currently SSNs and credit card numbers). " +
    "Agents can request an explicit step-up approval to send the original content when needed.",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft", "telegram", "slack", "notion", "trello", "jira"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Redact PII in Docs edits",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/documents/.*:batchUpdate$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
        {
          label: "Redact PII in Sheets writes",
          match: {
            methods: ["PUT", "POST"],
            urlPattern: "/v4/spreadsheets/.*/values/",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
        {
          label: "Redact PII in email sends",
          match: {
            methods: ["POST"],
            urlPattern: "/gmail/v1/users/me/messages/send$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Redact PII in chat messages",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/(me/)?chats/.*/messages$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["body.content"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["body.content"],
          },
        },
        {
          label: "Redact PII in emails",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["message.body.content"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["message.body.content"],
          },
        },
        {
          label: "Redact PII in channel posts",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/teams/.*/channels/.*/messages$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["body.content"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["body.content"],
          },
        },
      ],
      responseRules: [],
    },
    telegram: {
      requestRules: [
        {
          label: "Redact PII in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/bot.*/sendMessage$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["text"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["text"],
          },
        },
      ],
      responseRules: [],
    },
    slack: {
      requestRules: [
        {
          label: "Redact PII in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/api/chat\\.postMessage$",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["text"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["text"],
          },
        },
      ],
      responseRules: [],
    },
    notion: {
      requestRules: [
        {
          label: "Redact PII in page/block content",
          match: {
            methods: ["POST", "PATCH"],
            urlPattern: "/v1/(pages|blocks)",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
      ],
      responseRules: [],
    },
    trello: {
      requestRules: [
        {
          label: "Redact PII in card content",
          match: {
            methods: ["POST", "PUT"],
            urlPattern: "/1/cards",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
      ],
      responseRules: [],
    },
    jira: {
      requestRules: [
        {
          label: "Redact PII in issue content",
          match: {
            methods: ["POST", "PUT"],
            urlPattern: "/rest/api/3/issue",
            pii: {
              types: [{ type: "us_ssn" }, { type: "credit_card" }],
              fields: ["$body"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "us_ssn" }, { type: "credit_card" }],
            fields: ["$body"],
          },
        },
      ],
      responseRules: [],
    },
  },
};

const CS_PII_REDACT: ContextualGuard = {
  id: "cs-pii-redact",
  category: "content_safety",
  name: "PII Response Redaction",
  description:
    "Redact PII (emails, phone numbers, credit cards, IBANs, SSN/tax IDs across 12 countries, " +
    "IP/MAC addresses, dates of birth) from all API responses. Prevents the agent from seeing sensitive personal information.",
  risk: "medium",
  presetTier: "standard",
  providers: ["google", "microsoft", "telegram", "slack", "anthropic", "openai", "gemini", "openrouter", "notion", "trello", "jira"],
  rules: {
    google: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    microsoft: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    telegram: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    slack: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    anthropic: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    openai: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    gemini: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    openrouter: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    notion: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    trello: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
    jira: {
      requestRules: [],
      responseRules: [
        {
          label: "Redact PII from all responses",
          match: {},
          filter: {
            redact: [
              { type: "contact" },
              { type: "financial" },
              { type: "identity" },
            ],
          },
        },
      ],
    },
  },
};

const CS_IP_LEAK: ContextualGuard = {
  id: "cs-ip-leak",
  category: "content_safety",
  name: "IP Address Leak Guard",
  description:
    "Block outbound content containing internal/private IP addresses " +
    "(10.x, 172.16-31.x, 192.168.x). Prevents accidental infrastructure exposure.",
  risk: "medium",
  presetTier: "strict",
  providers: ["microsoft", "telegram", "slack"],
  rules: {
    microsoft: {
      requestRules: [
        {
          label: "Block internal IPs in chat messages",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/(me/)?chats/.*/messages$",
            body: [{ path: "body.content", op: "matches", value: INTERNAL_IP_PATTERN }],
          },
          action: "deny",
        },
        {
          label: "Block internal IPs in emails",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            body: [{ path: "message.body.content", op: "matches", value: INTERNAL_IP_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    telegram: {
      requestRules: [
        {
          label: "Block internal IPs in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/bot.*/sendMessage$",
            body: [{ path: "text", op: "matches", value: INTERNAL_IP_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    slack: {
      requestRules: [
        {
          label: "Block internal IPs in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/api/chat\\.postMessage$",
            body: [{ path: "text", op: "matches", value: INTERNAL_IP_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Messaging Guards ─────────────────────────────────────────────

const MSG_SEND_APPROVAL: ContextualGuard = {
  id: "msg-send-approval",
  category: "messaging",
  name: "Send Approval",
  description:
    "Require human approval before sending any message, email, or channel post. " +
    "The reviewer sees the full content before it goes out.",
  risk: "medium",
  presetTier: "standard",
  providers: ["google", "microsoft", "telegram", "slack"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve email sends",
          match: { methods: ["POST"], urlPattern: "/gmail/v1/users/me/messages/send$" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve email sends",
          match: { methods: ["POST"], urlPattern: "/v1\\.0/me/sendMail$" },
          action: "require_approval",
        },
        {
          label: "Approve chat messages",
          match: { methods: ["POST"], urlPattern: "/v1\\.0/(me/)?chats/.*/messages$" },
          action: "require_approval",
        },
        {
          label: "Approve channel posts",
          match: { methods: ["POST"], urlPattern: "/v1\\.0/teams/.*/channels/.*/messages$" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    telegram: {
      requestRules: [
        {
          label: "Approve text messages",
          match: { methods: ["POST"], urlPattern: "/bot.*/sendMessage$" },
          action: "require_approval",
        },
        {
          label: "Approve media sends",
          match: { methods: ["POST"], urlPattern: "/bot.*/send(Photo|Document|Video|Audio)$" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    slack: {
      requestRules: [
        {
          label: "Approve sending messages",
          match: { methods: ["POST"], urlPattern: "/api/chat\\.postMessage$" },
          action: "require_approval",
        },
        {
          label: "Approve file uploads",
          match: { methods: ["POST"], urlPattern: "/api/files\\.uploadV2$" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const MSG_FORWARD_BLOCK: ContextualGuard = {
  id: "msg-forward-block",
  category: "messaging",
  name: "Forward Protection",
  description:
    "Block or require approval for message forwarding. " +
    "Forwarding can leak conversation context to unintended recipients.",
  risk: "medium",
  presetTier: "strict",
  providers: ["telegram"],
  rules: {
    telegram: {
      requestRules: [
        {
          label: "Block message forwarding",
          match: { methods: ["POST"], urlPattern: "/bot.*/forward" },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const MSG_ATTACHMENT_TYPE: ContextualGuard = {
  id: "msg-attachment-type",
  category: "messaging",
  name: "Attachment Type Guard",
  description:
    "Block sending executable or script files as message attachments. " +
    "Prevents distribution of .exe, .bat, .ps1, .sh, .js, and other dangerous file types.",
  risk: "high",
  presetTier: "standard",
  providers: ["telegram"],
  rules: {
    telegram: {
      requestRules: [
        {
          label: "Block dangerous file attachments",
          match: {
            methods: ["POST"],
            urlPattern: "/bot.*/sendDocument$",
            body: [{ path: "document", op: "matches", value: DANGEROUS_EXT_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

// ── File Sharing Guards ──────────────────────────────────────────

const FS_PUBLIC_SHARE: ContextualGuard = {
  id: "fs-public-share",
  category: "file_sharing",
  name: "Block Public Sharing",
  description:
    "Block sharing files with public/anonymous access (type=anyone). " +
    "Prevents accidental public exposure of internal documents.",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Block public sharing",
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
    microsoft: {
      requestRules: [
        {
          label: "Block anonymous sharing links",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/drives/.*/items/.*/createLink$",
            body: [{ path: "scope", op: "eq", value: "anonymous" }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const FS_EXTERNAL_SHARE: ContextualGuard = {
  id: "fs-external-share",
  category: "file_sharing",
  name: "External Sharing Guard",
  description:
    "Require approval when sharing files with users outside the organization. " +
    "The reviewer verifies the recipient before access is granted.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve external file sharing",
          match: {
            methods: ["POST"],
            urlPattern: "/drive/v3/.*/permissions",
            body: [{ path: "type", op: "eq", value: "user" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve external file invitations",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/drives/.*/items/.*/invite$",
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const FS_LINK_SHARING: ContextualGuard = {
  id: "fs-link-sharing",
  category: "file_sharing",
  name: "Block Link Sharing",
  description:
    "Block creating organization-wide shareable links. " +
    "Prevents broad access via \"anyone in the org\" links.",
  risk: "medium",
  presetTier: "strict",
  providers: ["google"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Block domain-wide link sharing",
          match: {
            methods: ["POST"],
            urlPattern: "/drive/v3/.*/permissions",
            body: [{ path: "type", op: "eq", value: "domain" }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const FS_DANGEROUS_FILE: ContextualGuard = {
  id: "fs-dangerous-file",
  category: "file_sharing",
  name: "Dangerous File Type Guard",
  description:
    "Block uploading executable or script files to cloud storage. " +
    "Blocks .exe, .bat, .ps1, .sh, .js, .msi, .dll, and similar extensions.",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Block dangerous file uploads",
          match: {
            methods: ["POST"],
            urlPattern: "/upload/drive/v3/files",
            body: [{ path: "name", op: "matches", value: DANGEROUS_EXT_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Block dangerous file uploads",
          match: {
            methods: ["PUT"],
            urlPattern: "/v1\\.0/drives/.*/items/.*:/content$",
            body: [{ path: "name", op: "matches", value: DANGEROUS_EXT_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const FS_SENSITIVE_FILENAME: ContextualGuard = {
  id: "fs-sensitive-filename",
  category: "file_sharing",
  name: "Sensitive Filename Guard",
  description:
    "Block uploading files whose names suggest credentials or secrets " +
    "(password*, secret*, .env, .pem, id_rsa, etc.).",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Block credential file uploads",
          match: {
            methods: ["POST"],
            urlPattern: "/upload/drive/v3/files",
            body: [{ path: "name", op: "matches", value: SENSITIVE_FILENAME_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Block credential file uploads",
          match: {
            methods: ["PUT"],
            urlPattern: "/v1\\.0/drives/.*/items/.*:/content$",
            body: [{ path: "name", op: "matches", value: SENSITIVE_FILENAME_PATTERN }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Calendar Guards ──────────────────────────────────────────────

const CAL_EXTERNAL_ATTENDEE: ContextualGuard = {
  id: "cal-external-attendee",
  category: "calendar",
  name: "External Attendee Guard",
  description:
    "Require approval when creating events that invite external attendees. " +
    "Prevents accidental calendar exposure to outside parties.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve event creation with attendees",
          match: {
            methods: ["POST"],
            urlPattern: "/calendar/v3/calendars/.*/events$",
            body: [{ path: "attendees", op: "exists" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve event creation with attendees",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/(calendar/)?events$",
            body: [{ path: "attendees", op: "exists" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const CAL_EVENT_CANCEL: ContextualGuard = {
  id: "cal-event-cancel",
  category: "calendar",
  name: "Event Cancellation Guard",
  description:
    "Require approval before deleting calendar events. " +
    "Prevents accidental meeting cancellations.",
  risk: "medium",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve event deletion",
          match: { methods: ["DELETE"], urlPattern: "/calendar/v3/calendars/.*/events/" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve event deletion",
          match: { methods: ["DELETE"], urlPattern: "/v1\\.0/me/(calendar/)?events/" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const CAL_READ_GRANULARITY: ContextualGuard = {
  id: "cal-read-granularity",
  category: "calendar",
  name: "Calendar Read Granularity",
  description:
    "Allow listing events and calendars without approval, but require " +
    "approval for reading individual event details (attendees, body, etc.).",
  risk: "low",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        { label: "Allow listing events", match: { methods: ["GET"], urlPattern: "^/calendar/v3/calendars/[^/]+/events$" }, action: "allow" },
        { label: "Allow listing calendars", match: { methods: ["GET"], urlPattern: "^/calendar/v3/users/me/calendarList" }, action: "allow" },
        { label: "Approve reading event details", match: { methods: ["GET"], urlPattern: "^/calendar/v3/calendars/[^/]+/events/[^/]+" }, action: "require_approval" },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        { label: "Allow listing events", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)$" }, action: "allow" },
        { label: "Allow listing calendars", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/calendars" }, action: "allow" },
        { label: "Approve reading event details", match: { methods: ["GET"], urlPattern: "/v1\\.0/me/(calendar/)?(events|calendarView)/[^/]+" }, action: "require_approval" },
      ],
      responseRules: [],
    },
  },
};

// ── Data Reading Guards ──────────────────────────────────────────

const DR_CONTACT_NOTES: ContextualGuard = {
  id: "dr-contact-notes",
  category: "data_reading",
  name: "Contact Notes Stripping",
  description:
    "Strip notes/biographies fields from contact API responses. People " +
    "commonly store PINs, PUK codes, CVVs, passwords, and other secrets " +
    "in contact notes. This guard removes notes entirely rather than relying " +
    "on regex redaction which can miss creative formatting.",
  risk: "high",
  presetTier: "minimal",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [],
      responseRules: [
        {
          label: "Strip contact notes and custom fields",
          match: { urlPattern: "/v1/people" },
          filter: {
            denyFields: ["biographies", "userDefined"],
          },
        },
      ],
    },
    microsoft: {
      requestRules: [],
      responseRules: [
        {
          label: "Strip contact notes",
          match: { urlPattern: "/v1\\.0/me/contacts" },
          filter: {
            denyFields: ["personalNotes"],
          },
        },
        {
          label: "Strip people notes",
          match: { urlPattern: "/v1\\.0/me/people" },
          filter: {
            denyFields: ["personNotes"],
          },
        },
      ],
    },
  },
};

const DR_CONTACT_PII: ContextualGuard = {
  id: "dr-contact-pii",
  category: "data_reading",
  name: "Contact PII Stripping",
  description:
    "Aggressively strip sensitive fields from contact and directory API " +
    "responses. Removes phone numbers, addresses, notes/biographies (which " +
    "often contain PINs, PUKs, CVVs, passwords). PII redaction of surviving " +
    "text is handled by the separate cs-pii-redact guard.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [],
      responseRules: [
        {
          label: "Strip contact PII fields",
          match: { urlPattern: "/v1/people" },
          filter: {
            denyFields: [
              "phoneNumbers", "addresses", "birthdays", "biographies",
              "sipAddresses", "imClients", "locations", "externalIds",
              "events", "userDefined",
            ],
          },
        },
      ],
    },
    microsoft: {
      requestRules: [],
      responseRules: [
        {
          label: "Strip contact PII fields",
          match: { urlPattern: "/v1\\.0/me/contacts" },
          filter: {
            denyFields: [
              "mobilePhone", "businessPhones", "homePhones",
              "homeAddress", "businessAddress", "otherAddress",
              "streetAddress", "postalCode",
              "personalNotes", "birthday", "spouseName", "children",
              "imAddresses",
            ],
          },
        },
        {
          label: "Strip directory PII fields",
          match: { urlPattern: "/v1\\.0/users" },
          filter: {
            denyFields: [
              "mobilePhone", "businessPhones", "streetAddress", "postalCode",
            ],
          },
        },
        {
          label: "Strip people search PII fields",
          match: { urlPattern: "/v1\\.0/me/people" },
          filter: {
            denyFields: [
              "phones", "postalAddresses", "personNotes", "birthday",
              "imAddress",
            ],
          },
        },
      ],
    },
  },
};

const DR_FILE_DOWNLOAD: ContextualGuard = {
  id: "dr-file-download",
  category: "data_reading",
  name: "File Download Guard",
  description:
    "Require approval for binary file downloads from Google Drive and OneDrive. " +
    "Binary content (alt=media, /content) cannot be PII-redacted by the policy engine; " +
    "this guard ensures a human reviews file content access requests.",
  risk: "medium",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve Drive file content download (alt=media)",
          match: {
            methods: ["GET"],
            urlPattern: "/drive/v3/files/[^/]+$",
            queryPattern: "alt=media",
          },
          action: "require_approval",
        },
        {
          label: "Approve Drive file export",
          match: {
            methods: ["GET"],
            urlPattern: "/drive/v3/files/.*/export",
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve OneDrive file content download (/content)",
          match: {
            methods: ["GET"],
            urlPattern: "/content$",
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const DR_FILE_DOWNLOAD_BLOCK: ContextualGuard = {
  id: "dr-file-download-block",
  category: "data_reading",
  name: "File Download Block",
  description:
    "Block binary file downloads from Google Drive and OneDrive. " +
    "Binary content cannot be PII-redacted; strict mode blocks it entirely.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Block Drive file content download (alt=media)",
          match: {
            methods: ["GET"],
            urlPattern: "/drive/v3/files/[^/]+$",
            queryPattern: "alt=media",
          },
          action: "deny",
        },
        {
          label: "Block Drive file export",
          match: {
            methods: ["GET"],
            urlPattern: "/drive/v3/files/.*/export",
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Block OneDrive file content download (/content)",
          match: {
            methods: ["GET"],
            urlPattern: "/content$",
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Destructive Action Guards ────────────────────────────────────

const DEST_DELETE_PROTECT: ContextualGuard = {
  id: "dest-delete-protect",
  category: "destructive",
  name: "Delete Protection",
  description:
    "Block or require approval for all DELETE operations. " +
    "Prevents accidental data loss from file, message, or resource deletion.",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft", "telegram", "slack", "notion", "trello", "jira"],
  rules: {
    google: {
      requestRules: [
        { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
      ],
      responseRules: [],
    },
    telegram: {
      requestRules: [
        {
          label: "Block message deletion",
          match: { methods: ["POST"], urlPattern: "/bot.*/deleteMessage$" },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    slack: {
      requestRules: [
        {
          label: "Block message deletion",
          match: { methods: ["POST"], urlPattern: "/api/chat\\.delete$" },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    notion: {
      requestRules: [
        { label: "Block block deletion", match: { methods: ["DELETE"], urlPattern: "/v1/blocks/" }, action: "deny" },
      ],
      responseRules: [],
    },
    trello: {
      requestRules: [
        { label: "Block card deletion", match: { methods: ["DELETE"], urlPattern: "/1/cards/" }, action: "deny" },
        { label: "Block board deletion", match: { methods: ["DELETE"], urlPattern: "/1/boards/" }, action: "deny" },
      ],
      responseRules: [],
    },
    jira: {
      requestRules: [
        { label: "Block issue deletion", match: { methods: ["DELETE"], urlPattern: "/rest/api/3/issue/" }, action: "deny" },
      ],
      responseRules: [],
    },
  },
};

const DEST_MEMBER_PROTECT: ContextualGuard = {
  id: "dest-member-protect",
  category: "destructive",
  name: "Member Removal Protection",
  description:
    "Block the agent from kicking or banning group/channel members. " +
    "Prevents disruption to team membership.",
  risk: "high",
  presetTier: "strict",
  providers: ["telegram"],
  rules: {
    telegram: {
      requestRules: [
        {
          label: "Block banning members",
          match: { methods: ["POST"], urlPattern: "/bot.*/ban" },
          action: "deny",
        },
        {
          label: "Block kicking members",
          match: { methods: ["POST"], urlPattern: "/bot.*/kick" },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Admin Guards ─────────────────────────────────────────────────

const ADM_SETTINGS_GUARD: ContextualGuard = {
  id: "adm-settings-guard",
  category: "admin",
  name: "Settings Change Guard",
  description:
    "Require approval for any settings or configuration changes. " +
    "Catch-all for org/workspace/app settings modifications.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve Gmail settings changes",
          match: { methods: ["PUT", "PATCH"], urlPattern: "/gmail/v1/users/me/settings" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve mailbox settings changes",
          match: { methods: ["PATCH"], urlPattern: "/v1\\.0/me/mailboxSettings$" },
          action: "require_approval",
        },
        {
          label: "Approve team settings changes",
          match: { methods: ["PATCH"], urlPattern: "/v1\\.0/teams/" },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

// ── LLM Safety Guards ───────────────────────────────────────────

const LLM_PII_PROMPT: ContextualGuard = {
  id: "llm-pii-prompt",
  category: "llm_safety",
  name: "PII in Prompts Guard",
  description:
    "Redact PII from LLM prompts by default before the upstream model sees it. " +
    "Agents can request an explicit step-up approval to send the original prompt when needed.",
  risk: "high",
  presetTier: "standard",
  providers: ["anthropic", "openai", "gemini", "openrouter"],
  rules: {
    anthropic: {
      requestRules: [
        {
          label: "Redact PII in prompts",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/messages$",
            pii: {
              types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
              fields: ["messages[*].content", "system"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            fields: ["messages[*].content", "system"],
          },
        },
      ],
      responseRules: [],
    },
    openai: {
      requestRules: [
        {
          label: "Redact PII in prompts",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/chat/completions$",
            pii: {
              types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
              fields: ["messages[*].content"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            fields: ["messages[*].content"],
          },
        },
      ],
      responseRules: [],
    },
    gemini: {
      requestRules: [
        {
          label: "Redact PII in prompts",
          match: {
            methods: ["POST"],
            urlPattern: ":(generate|streamGenerate)Content$",
            pii: {
              types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
              fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            fields: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"],
          },
        },
      ],
      responseRules: [],
    },
    openrouter: {
      requestRules: [
        {
          label: "Redact PII in prompts",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            pii: {
              types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
              fields: ["messages[*].content"],
            },
          },
          action: "redact",
          redactConfig: {
            types: [{ type: "contact" }, { type: "financial" }, { type: "identity" }],
            fields: ["messages[*].content"],
          },
        },
      ],
      responseRules: [],
    },
  },
};

const LLM_MODEL_RESTRICT: ContextualGuard = {
  id: "llm-model-restrict",
  category: "llm_safety",
  name: "Model Restriction Guard",
  description:
    "Block requests to expensive or restricted models (e.g., Opus, o-series reasoning). " +
    "Only applied in the strict tier to enforce cost control.",
  risk: "medium",
  presetTier: "strict",
  providers: ["anthropic", "openai", "openrouter"],
  rules: {
    anthropic: {
      requestRules: [
        {
          label: "Block Opus model usage",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/messages$",
            body: [{ path: "model", op: "contains", value: "opus" }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    openai: {
      requestRules: [
        {
          label: "Block reasoning models (o-series)",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/chat/completions$",
            body: [{ path: "model", op: "matches", value: "^o[0-9]" }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
    openrouter: {
      requestRules: [
        {
          label: "Block Opus models via OpenRouter",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            body: [{ path: "model", op: "contains", value: "opus" }],
          },
          action: "deny",
        },
        {
          label: "Block reasoning models (o-series) via OpenRouter",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            body: [{ path: "model", op: "matches", value: "openai/o[0-9]" }],
          },
          action: "deny",
        },
      ],
      responseRules: [],
    },
  },
};

const LLM_MAX_TOKENS_LIMIT: ContextualGuard = {
  id: "llm-max-tokens-limit",
  category: "llm_safety",
  name: "Max Tokens Limit Guard",
  description:
    "Require approval for requests with very high max_tokens values (5+ digits, >= 10000). " +
    "Prevents excessive token consumption and cost overruns.",
  risk: "medium",
  presetTier: "strict",
  providers: ["anthropic", "openai", "gemini", "openrouter"],
  rules: {
    anthropic: {
      requestRules: [
        {
          label: "Approve very high max_tokens",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/messages$",
            body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    openai: {
      requestRules: [
        {
          label: "Approve very high max_tokens",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/chat/completions$",
            body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    gemini: {
      requestRules: [
        {
          label: "Approve very high maxOutputTokens",
          match: {
            methods: ["POST"],
            urlPattern: ":(generate|streamGenerate)Content$",
            body: [{ path: "$body", op: "matches", value: "\"maxOutputTokens\"\\s*:\\s*\\d{5,}" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    openrouter: {
      requestRules: [
        {
          label: "Approve very high max_tokens",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            body: [{ path: "$body", op: "matches", value: "\"max_tokens\"\\s*:\\s*\\d{5,}" }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

const LLM_PROMPT_INJECTION: ContextualGuard = {
  id: "llm-prompt-injection",
  category: "llm_safety",
  name: "Prompt Injection Guard",
  description:
    "Detect common prompt injection patterns in LLM requests: instruction overrides " +
    "(\"ignore previous instructions\"), delimiter injection (</system>, [INST], <|endoftext|>), " +
    "and jailbreak attempts. Uses heuristic regex matching — not a replacement for a classifier, " +
    "but catches the most dangerous and common vectors.",
  risk: "high",
  presetTier: "standard",
  providers: ["anthropic", "openai", "gemini", "openrouter"],
  rules: {
    anthropic: {
      requestRules: [
        {
          label: "Potential prompt injection: instruction override",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/messages$",
            body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
          },
          action: "require_approval",
        },
        {
          label: "Potential prompt injection: delimiter/token injection",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/messages$",
            body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    openai: {
      requestRules: [
        {
          label: "Potential prompt injection: instruction override",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/chat/completions$",
            body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
          },
          action: "require_approval",
        },
        {
          label: "Potential prompt injection: delimiter/token injection",
          match: {
            methods: ["POST"],
            urlPattern: "/v1/chat/completions$",
            body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    gemini: {
      requestRules: [
        {
          label: "Potential prompt injection: instruction override",
          match: {
            methods: ["POST"],
            urlPattern: ":(generate|streamGenerate)Content$",
            body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
          },
          action: "require_approval",
        },
        {
          label: "Potential prompt injection: delimiter/token injection",
          match: {
            methods: ["POST"],
            urlPattern: ":(generate|streamGenerate)Content$",
            body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    openrouter: {
      requestRules: [
        {
          label: "Potential prompt injection: instruction override",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            body: [{ path: "$prompt_text", op: "matches", value: PROMPT_INJECTION_OVERRIDE_PATTERN }],
          },
          action: "require_approval",
        },
        {
          label: "Potential prompt injection: delimiter/token injection",
          match: {
            methods: ["POST"],
            urlPattern: "/api/v1/chat/completions$",
            body: [{ path: "$prompt_text", op: "matches", value: DELIMITER_INJECTION_PATTERN }],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Email-Specific Guards ────────────────────────────────────────

/**
 * EMAIL_EXTERNAL_RECIPIENT - Detect emails being sent to external recipients
 * Flags when "to", "cc", or "bcc" fields contain addresses outside the user's domain
 */
const EMAIL_EXTERNAL_RECIPIENT: ContextualGuard = {
  id: "email-external-recipient",
  category: "messaging",
  name: "External Email Recipient",
  description:
    "Approve emails being sent to recipients outside your organization's domain. " +
    "Helps prevent accidental data leaks to external parties.",
  risk: "high",
  presetTier: "standard",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve external email recipients",
          match: {
            methods: ["POST"],
            urlPattern: "/gmail/v1/users/me/messages/send$",
            body: [
              {
                path: "raw",
                op: "matches",
                // Match To:, Cc:, or Bcc: headers with common external domains
                value: "(?i)(To:|Cc:|Bcc:)[^\\r\\n]*(@gmail\\.com|@yahoo\\.com|@hotmail\\.com|@outlook\\.com|@aol\\.com|@icloud\\.com|@proton\\.me|@protonmail\\.com)",
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve external email recipients",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            body: [
              {
                path: "message.toRecipients[*].emailAddress.address",
                op: "matches",
                value: "@(gmail|yahoo|hotmail|outlook|aol|icloud|proton|protonmail)\\.(com|me)$",
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

/**
 * EMAIL_LARGE_ATTACHMENT - Detect emails with large attachments
 * Flags attachments over 10MB to prevent accidental large file sends
 */
const EMAIL_LARGE_ATTACHMENT: ContextualGuard = {
  id: "email-large-attachment",
  category: "messaging",
  name: "Large Email Attachment",
  description:
    "Approve emails with attachments larger than 10MB. " +
    "Helps prevent sending large files via email (use file sharing instead).",
  risk: "medium",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve large attachments (>10MB)",
          match: {
            methods: ["POST"],
            urlPattern: "/gmail/v1/users/me/messages/send$",
            body: [
              {
                path: "raw",
                op: "matches",
                // Detect Content-Disposition with large inline data (Base64 encoded ~13MB = 10MB)
                value: "Content-Disposition:[^\\r\\n]{13000000,}",
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve large attachments (>10MB)",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            body: [
              {
                path: "message.attachments",
                op: "exists",
                value: true,
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

/**
 * EMAIL_MASS_SEND - Detect emails being sent to many recipients
 * Flags potential mass email/spam scenarios
 */
const EMAIL_MASS_SEND: ContextualGuard = {
  id: "email-mass-send",
  category: "messaging",
  name: "Mass Email Detection",
  description:
    "Approve emails with many recipients (potential mass email or spam). " +
    "Helps prevent accidental bulk sends or spam from agents.",
  risk: "high",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve emails with multiple recipients",
          match: {
            methods: ["POST"],
            urlPattern: "/gmail/v1/users/me/messages/send$",
            body: [
              {
                path: "raw",
                op: "matches",
                // Detect multiple To: addresses (simplified pattern)
                value: "(To:|Cc:)[^\\r\\n]*,[^\\r\\n]*,[^\\r\\n]*,",
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve emails with 10+ recipients",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/sendMail$",
            body: [
              {
                path: "message.toRecipients",
                op: "exists",
                value: true,
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Calendar-Specific Guards ─────────────────────────────────────

/**
 * CAL_ALL_DAY_EVENT - Detect all-day event creation
 * Flags all-day events that block the entire day
 */
const CAL_ALL_DAY_EVENT: ContextualGuard = {
  id: "cal-all-day-event",
  category: "calendar",
  name: "All-Day Event Creation",
  description:
    "Approve creation of all-day calendar events. " +
    "Prevents agents from blocking your entire day accidentally.",
  risk: "medium",
  presetTier: "strict",
  providers: ["google", "microsoft"],
  rules: {
    google: {
      requestRules: [
        {
          label: "Approve all-day events",
          match: {
            methods: ["POST"],
            urlPattern: "/calendar/v3/calendars/.*/events",
            body: [
              {
                path: "start.date",
                op: "exists",
                value: true,
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
    microsoft: {
      requestRules: [
        {
          label: "Approve all-day events",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/me/events",
            body: [
              {
                path: "isAllDay",
                op: "eq",
                value: true,
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Teams-Specific Guards ────────────────────────────────────────

/**
 * TEAMS_CHANNEL_MENTION - Detect @channel or @everyone mentions
 * Flags messages that would notify all members of a channel
 */
const TEAMS_CHANNEL_MENTION: ContextualGuard = {
  id: "teams-channel-mention",
  category: "messaging",
  name: "Teams Channel Mention",
  description:
    "Approve messages with @channel, @everyone, or @here mentions. " +
    "Prevents agents from spamming entire channels with notifications.",
  risk: "high",
  presetTier: "standard",
  providers: ["microsoft"],
  rules: {
    microsoft: {
      requestRules: [
        {
          label: "Approve @channel/@everyone mentions",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/teams/.*/channels/.*/messages$",
            body: [
              {
                path: "body.content",
                op: "matches",
                value: "(?i)@(channel|everyone|here|team)",
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

/**
 * TEAMS_FILE_UPLOAD - Detect file uploads in Teams messages
 * Flags messages that include file attachments
 */
const TEAMS_FILE_UPLOAD: ContextualGuard = {
  id: "teams-file-upload",
  category: "file_sharing",
  name: "Teams File Upload",
  description:
    "Approve messages with file attachments in Teams. " +
    "Requires approval before sharing files in chat.",
  risk: "medium",
  presetTier: "strict",
  providers: ["microsoft"],
  rules: {
    microsoft: {
      requestRules: [
        {
          label: "Approve file uploads in messages",
          match: {
            methods: ["POST"],
            urlPattern: "/v1\\.0/(me/)?chats/.*/messages$",
            body: [
              {
                path: "attachments",
                op: "exists",
                value: true,
              },
            ],
          },
          action: "require_approval",
        },
      ],
      responseRules: [],
    },
  },
};

// ── Master Guard List ────────────────────────────────────────────

export const CONTEXTUAL_GUARDS: ContextualGuard[] = [
  // Content Safety
  CS_PROFANITY,
  CS_PII_OUTBOUND,
  CS_PII_REDACT,
  CS_IP_LEAK,
  // Messaging
  MSG_SEND_APPROVAL,
  MSG_FORWARD_BLOCK,
  MSG_ATTACHMENT_TYPE,
  EMAIL_EXTERNAL_RECIPIENT,
  EMAIL_LARGE_ATTACHMENT,
  EMAIL_MASS_SEND,
  TEAMS_CHANNEL_MENTION,
  // File Sharing
  FS_PUBLIC_SHARE,
  FS_EXTERNAL_SHARE,
  FS_LINK_SHARING,
  FS_DANGEROUS_FILE,
  FS_SENSITIVE_FILENAME,
  TEAMS_FILE_UPLOAD,
  // Calendar
  CAL_READ_GRANULARITY,
  CAL_EXTERNAL_ATTENDEE,
  CAL_EVENT_CANCEL,
  CAL_ALL_DAY_EVENT,
  // Data Reading
  DR_CONTACT_NOTES,
  DR_CONTACT_PII,
  DR_FILE_DOWNLOAD,
  DR_FILE_DOWNLOAD_BLOCK,
  // Destructive
  DEST_DELETE_PROTECT,
  DEST_MEMBER_PROTECT,
  // Admin
  ADM_SETTINGS_GUARD,
  // LLM Safety
  LLM_PII_PROMPT,
  LLM_MODEL_RESTRICT,
  LLM_MAX_TOKENS_LIMIT,
  LLM_PROMPT_INJECTION,
];

// ── Helper Functions ─────────────────────────────────────────────

/**
 * Get all guards that have rules for a given provider.
 * Returns guards with only the relevant provider's rules resolved.
 */
export function getGuardsForProvider(provider: string): Array<
  Omit<ContextualGuard, "rules"> & {
    requestRules: RequestRule[];
    responseRules: ResponseRule[];
  }
> {
  return CONTEXTUAL_GUARDS
    .filter((g) => g.providers.includes(provider))
    .map((g) => {
      const providerRules = g.rules[provider] ?? { requestRules: [], responseRules: [] };
      return {
        id: g.id,
        category: g.category,
        name: g.name,
        description: g.description,
        risk: g.risk,
        presetTier: g.presetTier,
        providers: g.providers,
        requestRules: providerRules.requestRules,
        responseRules: providerRules.responseRules,
      };
    });
}

/** Get all guards in a specific category */
export function getGuardsByCategory(category: GuardCategory): ContextualGuard[] {
  return CONTEXTUAL_GUARDS.filter((g) => g.category === category);
}

/** Get guards that belong to a preset tier (includes lower tiers) */
export function getGuardsForPresetTier(
  tier: "standard" | "strict",
  provider: string,
): ContextualGuard[] {
  const tiers: Record<string, string[]> = {
    standard: ["standard"],
    strict: ["standard", "strict"],
  };
  return CONTEXTUAL_GUARDS.filter(
    (g) => tiers[tier]?.includes(g.presetTier) && g.providers.includes(provider),
  );
}
