/**
 * Policy template definitions for agent permission requests
 *
 * Each action type (gmail-read, calendar-read, etc.) has three preset tiers:
 * - Strict: Strict restrictions, maximum security (most restrictive)
 * - Standard: Balanced security and usability (DEFAULT)
 * - Minimal: Minimal restrictions, maximum flexibility (most permissive)
 */

export type PolicyTier = "strict" | "standard" | "minimal";

/**
 * Policy template with optional base template reference
 * If baseTemplate is specified, this template inherits from the base
 * and only overrides fields that are explicitly defined
 */
export interface PolicyTemplateWithRef {
  tier: PolicyTier;
  name: string;
  description: string;
  recommended?: boolean;
  icon: string;
  /**
   * Reference to base template to inherit from
   * Format: "actionTemplateId:tier" (e.g., "gmail-manage:strict")
   */
  baseTemplate?: string;
  guards?: string[];
}

/**
 * Fully resolved policy template (no references)
 */
export interface PolicyTemplate {
  tier: PolicyTier;
  name: string;
  description: string;
  recommended?: boolean;
  icon: string;
  guards: string[];
}

export const POLICY_TEMPLATES: Record<string, Record<PolicyTier, PolicyTemplateWithRef>> = {
  "gmail-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "calendar-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cal-read-granularity", "cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "teams-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "drive-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["dr-file-download-block", "cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dr-file-download", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "gmail-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-profanity", "cs-pii-outbound", "msg-send-approval", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-outbound", "msg-send-approval"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "calendar-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cal-read-granularity", "cs-profanity", "cs-pii-outbound", "cal-external-attendee", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-outbound", "cal-external-attendee"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "teams-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-profanity", "cs-pii-outbound", "msg-send-approval", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "anthropic-messages": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "llm-model-restrict", "llm-max-tokens-limit", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "openai": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "llm-model-restrict", "llm-max-tokens-limit", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "gemini": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "llm-model-restrict", "llm-max-tokens-limit", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "drive-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["dr-file-download-block", "cs-pii-redact", "fs-public-share", "fs-external-share", "fs-dangerous-file", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dr-file-download", "fs-public-share", "fs-external-share", "fs-dangerous-file"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "outlook-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "outlook-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-profanity", "cs-pii-outbound", "msg-send-approval", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-outbound", "msg-send-approval"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "telegram": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-profanity", "cs-pii-redact", "cs-pii-outbound", "msg-send-approval", "tg-chat-allowlist"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-redact", "cs-pii-outbound", "tg-chat-allowlist"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "slack": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-profanity", "cs-pii-redact", "cs-pii-outbound", "msg-send-approval", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-profanity", "cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "openrouter": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "llm-max-tokens-limit", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["llm-prompt-injection", "llm-pii-prompt", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "docs-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "docs-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact", "cs-pii-outbound", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "sheets-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "sheets-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cs-pii-redact", "cs-pii-outbound", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "notion-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read-only with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Read access with search",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Full read access",
      icon: "⚡",
      guards: [],
    },
  },

  "notion-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read + write with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "cs-pii-outbound", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Full read/write, approval for deletes",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Full CRUD access",
      icon: "⚡",
      guards: [],
    },
  },

  // ── Outlook Calendar ────────────────────────────────────
  "outlook-calendar-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cal-read-granularity", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "outlook-calendar-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["cal-read-granularity", "cal-external-attendee", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cal-external-attendee"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  // ── OneDrive ──────────────────────────────────────────────
  "onedrive-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["dr-file-download-block", "cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dr-file-download", "dest-delete-protect"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  "onedrive-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Maximum security",
      icon: "🔒",
      guards: ["dr-file-download-block", "cs-pii-redact", "fs-public-share", "fs-external-share", "fs-dangerous-file", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Balanced security",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "dr-file-download", "fs-public-share", "fs-external-share", "fs-dangerous-file"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Maximum flexibility",
      icon: "⚡",
      guards: [],
    },
  },

  // ── Google Contacts ───────────────────────────────────────
  "contacts-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Strips phone numbers, addresses, notes, and sensitive fields",
      icon: "🔒",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "PII fields stripped by default, agent can request full fields via approval",
      recommended: true,
      icon: "🛡️",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Notes always stripped for safety",
      icon: "⚡",
      guards: ["dr-contact-notes"],
    },
  },

  "contacts-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Strips sensitive fields, blocks deletion",
      icon: "🔒",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "PII fields stripped by default, agent can request full fields via approval",
      recommended: true,
      icon: "🛡️",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Notes always stripped for safety",
      icon: "⚡",
      guards: ["dr-contact-notes"],
    },
  },

  // ── Outlook Contacts ──────────────────────────────────────
  "outlook-contacts-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Strips phone numbers, addresses, notes, and sensitive fields",
      icon: "🔒",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "PII fields stripped by default, agent can request full fields via approval",
      recommended: true,
      icon: "🛡️",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Notes always stripped for safety",
      icon: "⚡",
      guards: ["dr-contact-notes"],
    },
  },

  "outlook-contacts-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Strips sensitive fields, blocks deletion",
      icon: "🔒",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "PII fields stripped by default, agent can request full fields via approval",
      recommended: true,
      icon: "🛡️",
      guards: ["dr-contact-notes", "dr-contact-pii", "cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Notes always stripped for safety",
      icon: "⚡",
      guards: ["dr-contact-notes"],
    },
  },

  // ── Trello ──────────────────────────────────────────────
  "trello-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read-only with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Read access to boards, lists, and cards",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Unrestricted read access",
      icon: "⚡",
      guards: [],
    },
  },

  "trello-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read + write with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "cs-pii-outbound", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Read/write, approval for deletes",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Full CRUD access",
      icon: "⚡",
      guards: [],
    },
  },

  // ── Jira Cloud ───────────────────────────────────────────
  "jira-read": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read-only with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Read access to issues, projects, and comments",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Unrestricted read access",
      icon: "⚡",
      guards: [],
    },
  },

  "jira-manage": {
    strict: {
      tier: "strict",
      name: "Strict",
      description: "Read + write with maximum oversight",
      icon: "🔒",
      guards: ["cs-pii-redact", "cs-pii-outbound", "dest-delete-protect"],
    },
    standard: {
      tier: "standard",
      name: "Standard",
      description: "Read/write, approval for deletes and transitions",
      recommended: true,
      icon: "🛡️",
      guards: ["cs-pii-redact", "cs-pii-outbound"],
    },
    minimal: {
      tier: "minimal",
      name: "Minimal",
      description: "Full CRUD access",
      icon: "⚡",
      guards: [],
    },
  },
};

/**
 * Resolve a template with base template reference to a fully resolved template
 * Recursively resolves chained references (A → B → C)
 */
export function resolveTemplate(template: PolicyTemplateWithRef): PolicyTemplate {
  // If no base template, this is a complete template
  if (!template.baseTemplate) {
    const resolved: PolicyTemplate = {
      tier: template.tier,
      name: template.name,
      description: template.description,
      icon: template.icon,
      guards: template.guards ?? [],
    };
    if (template.recommended !== undefined) {
      resolved.recommended = template.recommended;
    }
    return resolved;
  }

  // Parse base template reference (format: "actionTemplateId:tier")
  const [baseId, baseTierStr] = template.baseTemplate.split(":");
  if (!baseId || !baseTierStr) {
    throw new Error(
      `Invalid baseTemplate format: ${template.baseTemplate}. Expected "actionTemplateId:tier"`
    );
  }

  const baseTier = baseTierStr as PolicyTier;
  const baseTemplateWithRef = POLICY_TEMPLATES[baseId]?.[baseTier];
  if (!baseTemplateWithRef) {
    throw new Error(`Base template not found: ${template.baseTemplate}`);
  }

  // Recursively resolve base template (handles chains)
  const resolvedBase = resolveTemplate(baseTemplateWithRef);

  // Override fields that are explicitly defined
  const resolved: PolicyTemplate = {
    tier: template.tier,
    name: template.name,
    description: template.description,
    icon: template.icon,
    guards: template.guards ?? resolvedBase.guards,
  };

  // Only set recommended if defined (either in template or base)
  const recommendedValue = template.recommended ?? resolvedBase.recommended;
  if (recommendedValue !== undefined) {
    resolved.recommended = recommendedValue;
  }

  return resolved;
}

/**
 * Get policy templates for a specific action type
 */
export function getPolicyTemplates(actionTemplateId: string): PolicyTemplate[] {
  const templates = POLICY_TEMPLATES[actionTemplateId];
  if (!templates) {
    // Fallback to standard template if action type not found
    return [
      {
        tier: "standard",
        name: "Standard",
        description: "Balanced security and usability",
        recommended: true,
        icon: "🛡️",
        guards: [],
      },
    ];
  }

  return [
    resolveTemplate(templates.strict),
    resolveTemplate(templates.standard),
    resolveTemplate(templates.minimal),
  ];
}

/**
 * Get the default (recommended) template for an action type
 */
export function getDefaultTemplate(actionTemplateId: string): PolicyTemplate {
  const templates = POLICY_TEMPLATES[actionTemplateId];
  if (templates?.standard) {
    return resolveTemplate(templates.standard);
  }
  return getPolicyTemplates(actionTemplateId)[0]!;
}

/**
 * Get a specific template by action type and tier
 */
export function getPolicyTemplate(actionTemplateId: string, tier: PolicyTier): PolicyTemplate | null {
  const templateWithRef = POLICY_TEMPLATES[actionTemplateId]?.[tier];
  return templateWithRef ? resolveTemplate(templateWithRef) : null;
}
