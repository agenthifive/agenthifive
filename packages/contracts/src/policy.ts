import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

export const ExecutionModelSchema = z.enum(["A", "B"]);
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;

export const DefaultModeSchema = z.enum([
  "read_only",
  "read_write",
  "custom",
]);
export type DefaultMode = z.infer<typeof DefaultModeSchema>;

export const StepUpApprovalSchema = z.enum([
  "always",
  "risk_based",
  "never",
]);
export type StepUpApproval = z.infer<typeof StepUpApprovalSchema>;

export const AllowlistEntrySchema = z.object({
  baseUrl: z.string().url(),
  methods: z.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"])),
  pathPatterns: z.array(z.string().min(1)),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntrySchema>;

export const RateLimitSchema = z.object({
  maxRequestsPerHour: z.number().int().positive(),
  maxPayloadSizeBytes: z.number().int().positive().optional(),
  maxResponseSizeBytes: z.number().int().positive().optional(),
});
export type RateLimit = z.infer<typeof RateLimitSchema>;

export const TimeWindowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1),
});
export type TimeWindow = z.infer<typeof TimeWindowSchema>;

// ── Policy Rules Engine ────────────────────────────────────────────

const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]);

export const BodyConditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "contains", "matches", "exists"]),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .optional(),
});
export type BodyCondition = z.infer<typeof BodyConditionSchema>;

export const RequestRuleActionSchema = z.enum(["allow", "deny", "require_approval", "redact"]);
export type RequestRuleAction = z.infer<typeof RequestRuleActionSchema>;

export const RedactPatternSchema = z.object({
  type: z.enum([
    // Groups (expand to multiple recognizers)
    "all_pii",
    "financial",
    "identity",
    "contact",

    // Generic
    "email",
    "phone",
    "credit_card",
    "iban",
    "ip_address",
    "url",
    "crypto_wallet",
    "date_of_birth",
    "mac_address",
    "secret_code",

    // US
    "us_ssn",
    "us_itin",
    "us_passport",
    "us_driver_license",
    "us_bank_routing",
    "us_npi",

    // UK
    "uk_nhs",
    "uk_nino",

    // Italy
    "it_fiscal_code",
    "it_vat",
    "it_passport",
    "it_identity_card",
    "it_driver_license",

    // India
    "in_aadhaar",
    "in_pan",

    // Spain
    "es_nif",
    "es_nie",

    // Australia
    "au_tfn",
    "au_abn",

    // Other countries
    "pl_pesel",
    "fi_pic",
    "th_tnin",
    "kr_rrn",
    "sg_fin",

    // Legacy alias
    "ssn",

    // Custom regex
    "custom",
  ]),
  pattern: z.string().optional(),
  replacement: z.string().optional(),
});
export type RedactPattern = z.infer<typeof RedactPatternSchema>;

/**
 * Configuration for the "redact" request rule action.
 * Specifies which PII types to detect and which body fields to walk.
 */
export const RedactConfigSchema = z.object({
  /** PII recognizer types to detect and replace (reuses RedactPattern from response rules). */
  types: z.array(RedactPatternSchema),
  /**
   * JSON field paths to walk for redaction. Supports `[*]` array wildcards.
   * Examples: "messages[*].content", "system", "contents[*].parts[*].text"
   *
   * For Anthropic: ["messages[*].content", "system"]
   * For OpenAI/OpenRouter: ["messages[*].content"]
   * For Gemini: ["contents[*].parts[*].text", "systemInstruction.parts[*].text"]
   */
  fields: z.array(z.string().min(1)),
});
export type RedactConfig = z.infer<typeof RedactConfigSchema>;

/**
 * Configuration for request-side PII detection using the shared recognizer engine.
 * This detects PII in specific request-body fields without mutating the payload.
 */
export const PiiMatchConfigSchema = z.object({
  /** PII recognizer types/groups to scan for. Reuses the response redaction taxonomy. */
  types: z.array(RedactPatternSchema),
  /**
   * JSON field paths to scan. Supports `[*]` array wildcards.
   * Examples: "messages[*].content", "system", "contents[*].parts[*].text"
   */
  fields: z.array(z.string().min(1)),
});
export type PiiMatchConfig = z.infer<typeof PiiMatchConfigSchema>;

export const RequestRuleSchema = z.object({
  label: z.string().optional(),
  match: z.object({
    methods: z.array(HttpMethodSchema).optional(),
    urlPattern: z.string().optional(),
    queryPattern: z.string().optional(),
    body: z.array(BodyConditionSchema).optional(),
    pii: PiiMatchConfigSchema.optional(),
  }),
  action: RequestRuleActionSchema,
  /** PII redaction config — only used when action is "redact". */
  redactConfig: RedactConfigSchema.optional(),
});
export type RequestRule = z.infer<typeof RequestRuleSchema>;

export const ResponseRuleSchema = z.object({
  label: z.string().optional(),
  match: z.object({
    urlPattern: z.string().optional(),
    queryPattern: z.string().optional(),
    methods: z.array(HttpMethodSchema).optional(),
  }),
  filter: z.object({
    allowFields: z.array(z.string()).optional(),
    denyFields: z.array(z.string()).optional(),
    redact: z.array(RedactPatternSchema).optional(),
  }),
});
export type ResponseRule = z.infer<typeof ResponseRuleSchema>;

export const PolicyRulesSchema = z.object({
  request: z.array(RequestRuleSchema).default([]),
  response: z.array(ResponseRuleSchema).default([]),
  fieldStepUpEnabled: z.boolean().optional(),
});
export type PolicyRules = z.infer<typeof PolicyRulesSchema>;

// ── Guard Trigger (approval metadata for body-match rules) ───────

/**
 * Structured metadata attached to approval records when a body-match rule
 * triggers require_approval (prompt injection) or when an agent requests
 * bypassPiiRedaction (PII escalation).
 *
 * Stored in requestDetails.guardTrigger so the dashboard can show the
 * workspace owner exactly what was flagged.
 */
export const GuardTriggerMatchSchema = z.object({
  /** Recognizer/pattern that matched (e.g., "PROMPT_INJECTION_OVERRIDE", "us_ssn"). */
  patternType: z.string(),
  /** JSON field path where the match was found (e.g., "messages[3].content"). */
  field: z.string(),
  /** Short excerpt around the match. PII is redacted in the stored excerpt. */
  excerpt: z.string(),
});
export type GuardTriggerMatch = z.infer<typeof GuardTriggerMatchSchema>;

export const GuardTriggerSchema = z.object({
  type: z.enum(["prompt_injection", "pii_bypass"]),
  ruleLabel: z.string(),
  matches: z.array(GuardTriggerMatchSchema),
});
export type GuardTrigger = z.infer<typeof GuardTriggerSchema>;

// ── Provider Constraints ──────────────────────────────────────────

export const TelegramConstraintsSchema = z.object({
  allowedChatIds: z.array(z.string().min(1)),
});
export type TelegramConstraints = z.infer<typeof TelegramConstraintsSchema>;

export const MicrosoftConstraintsSchema = z.object({
  allowedTenantIds: z.array(z.string().min(1)).optional(),
  allowedChatIds: z.array(z.string().min(1)).optional(),
  allowedChannelIds: z.array(z.string().min(1)).optional(),
});
export type MicrosoftConstraints = z.infer<typeof MicrosoftConstraintsSchema>;

export const SlackConstraintsSchema = z.object({
  allowedChannelIds: z.array(z.string().min(1)).optional(),
  allowedUserIds: z.array(z.string().min(1)).optional(),
});
export type SlackConstraints = z.infer<typeof SlackConstraintsSchema>;

export const ProviderConstraintsSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("telegram"), ...TelegramConstraintsSchema.shape }),
  z.object({ provider: z.literal("microsoft"), ...MicrosoftConstraintsSchema.shape }),
  z.object({ provider: z.literal("slack"), ...SlackConstraintsSchema.shape }),
]);
export type ProviderConstraints = z.infer<typeof ProviderConstraintsSchema>;

// ── Policy ─────────────────────────────────────────────────────────

export const PolicySchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  connectionId: z.string().min(1),
  allowedModels: z.array(ExecutionModelSchema),
  defaultMode: DefaultModeSchema,
  stepUpApproval: StepUpApprovalSchema,
  allowlists: z.array(AllowlistEntrySchema),
  rateLimits: RateLimitSchema.nullable(),
  timeWindows: z.array(TimeWindowSchema),
  rules: PolicyRulesSchema.default({ request: [], response: [] }),
  providerConstraints: ProviderConstraintsSchema.nullable().default(null),
  securityPreset: z.enum(["minimal", "standard", "strict"]).nullable().default(null),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
});
export type Policy = z.infer<typeof PolicySchema>;
