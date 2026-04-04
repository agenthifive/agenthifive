---
title: Policy Engine
sidebar_position: 6
sidebar_label: Policy Engine
description: Declarative rule engine for request evaluation, response filtering, and contextual guards.
---

# Policy Engine

The policy engine is a compiled declarative rule engine that evaluates every Model B request before it reaches the provider API and filters every response before it reaches the agent.

## Why a Rule Engine

The naive approach -- classifying requests as "sensitive" purely by HTTP method -- cannot distinguish between `POST /gmail/v1/users/me/messages/send` (sending email to the CEO) and `POST /gmail/v1/users/me/labels` (creating a label). Both are POST requests, but they carry vastly different risk.

The policy engine adds:

- **Request evaluation** based on method + URL pattern + body content
- **Response filtering** with field allow/deny lists and PII redaction
- **Sub-100us overhead** per request (provider API calls are 50-500ms)
- **Compile-once, evaluate-many** semantics with in-memory caching

## Pipeline

```
Request arrives
  |
  v
[1] Existing checks (connection lookup, time windows, allowlists)
  |
  v
[2] REQUEST RULES -- ordered, first match wins
  |  Actions: allow | deny | require_approval | redact
  v
[3] Execute provider API call (Model B flow)
  |
  v
[4] RESPONSE RULES -- ordered, first match wins
  |  Filter: allowFields | denyFields | redact patterns
  v
Return filtered response
```

If no request rule matches, the existing step-up approval behavior is the fallback. Existing policies without rules continue to work unchanged.

## Request Rules

### Rule Structure

```typescript
interface RequestRule {
  label?: string;
  match: {
    methods?: string[];       // HTTP methods. Empty = match all
    urlPattern?: string;      // Regex against URL path. Omitted = match all
    queryPattern?: string;    // Regex against query string. Omitted = match all
    body?: BodyCondition[];   // JSON body conditions. All must match (AND)
    pii?: PiiMatchConfig;     // PII detection in request body fields (without mutating payload)
  };
  action: "allow" | "deny" | "require_approval" | "redact";
  /** PII redaction config -- only used when action is "redact". */
  redactConfig?: RedactConfig;
}

interface BodyCondition {
  path: string;    // Dot-notation into JSON body, e.g. "message.to"
  op: "eq" | "neq" | "in" | "not_in" | "contains" | "matches" | "exists";
  value?: string | number | boolean | string[];
}
```

### Evaluation Model

Rules are evaluated top-to-bottom. The **first matching rule** determines the action. This is the firewall model -- ordering matters, and the most specific rules go first.

```typescript
function evaluateRequestRules(
  rules: CompiledRequestRule[],
  method: string,
  urlPath: string,
  body: unknown,
): "allow" | "deny" | "require_approval" | "redact" | null {
  for (const rule of rules) {
    if (rule.methodSet && !rule.methodSet.has(method)) continue;
    if (rule.urlRegex && !rule.urlRegex.test(urlPath)) continue;
    if (rule.bodyConditions.length > 0) {
      if (!evaluateBodyConditions(rule.bodyConditions, body)) continue;
    }
    return rule.action;
  }
  return null; // No match -- fall through to legacy behavior
}
```

### Example: Google Gmail Policy

```json
{
  "request": [
    {
      "label": "Allow reading messages",
      "match": { "methods": ["GET"], "urlPattern": "^/gmail/v1/users/me/messages" },
      "action": "allow"
    },
    {
      "label": "Auto-approve label creation",
      "match": { "methods": ["POST"], "urlPattern": "^/gmail/v1/users/me/labels$" },
      "action": "allow"
    },
    {
      "label": "Approve external emails",
      "match": {
        "methods": ["POST"],
        "urlPattern": "^/gmail/v1/users/me/messages/send$",
        "body": [
          { "path": "message.to", "op": "not_in", "value": ["*@mycompany.com"] }
        ]
      },
      "action": "require_approval"
    },
    {
      "label": "Allow internal emails",
      "match": {
        "methods": ["POST"],
        "urlPattern": "^/gmail/v1/users/me/messages/send$"
      },
      "action": "allow"
    }
  ]
}
```

In this example, GET requests to the messages endpoint are always allowed. Label creation is auto-approved. Emails to external addresses require human approval, while internal emails are allowed. The ordering is critical -- the external email rule must come before the catch-all internal email rule.

## Response Rules

Response rules run after the provider API call returns and before sending data to the agent. For streaming responses (`stream: true`), response rules are applied in real-time per event/chunk using a stateful Transform stream -- no buffering of the entire response:

- **SSE** (`text/event-stream`): Each `data: {...}\n\n` event is buffered until the delimiter, parsed as JSON, filtered, and re-serialized
- **NDJSON** (`application/x-ndjson`): Each newline-delimited JSON line is parsed and filtered
- **Text** (`text/*`): PII redaction regex applied directly to each chunk
- **Binary/other**: Passed through unmodified

If no response rules are configured, streaming chunks pass through with zero overhead.

### Rule Structure

```typescript
interface ResponseRule {
  label?: string;
  match: {
    urlPattern?: string;
    methods?: string[];
  };
  filter: {
    allowFields?: string[];   // Only these dot-paths survive (allowlist)
    denyFields?: string[];    // These dot-paths are removed (denylist)
    redact?: RedactPattern[]; // PII patterns to redact in string values
  };
}
```

:::warning
`allowFields` and `denyFields` are mutually exclusive. Use one or the other per rule.
:::

### Field Filtering

**Allowlist mode** keeps only the specified fields:

```json
{
  "filter": {
    "allowFields": ["id", "name", "email"]
  }
}
```

**Denylist mode** removes the specified fields:

```json
{
  "label": "Strip PII from contact reads",
  "match": { "urlPattern": "/people/v1/people" },
  "filter": {
    "denyFields": ["phoneNumbers", "addresses", "birthdays"]
  }
}
```

### PII Redaction

Redaction patterns are applied to all string values in the response after field filtering. The engine supports 40+ built-in recognizer types organized by category:

| Category | Patterns |
|----------|----------|
| **Groups** | `all_pii`, `financial`, `identity`, `contact` (each expands to multiple recognizers) |
| **Generic** | `email`, `phone`, `credit_card`, `iban`, `ip_address`, `url`, `crypto_wallet`, `date_of_birth`, `mac_address`, `secret_code` |
| **US** | `us_ssn`, `us_itin`, `us_passport`, `us_driver_license`, `us_bank_routing`, `us_npi` |
| **UK** | `uk_nhs`, `uk_nino` |
| **Italy** | `it_fiscal_code`, `it_vat`, `it_passport`, `it_identity_card`, `it_driver_license` |
| **India** | `in_aadhaar`, `in_pan` |
| **Spain** | `es_nif`, `es_nie` |
| **Australia** | `au_tfn`, `au_abn` |
| **Other countries** | `pl_pesel`, `fi_pic`, `th_tnin`, `kr_rrn`, `sg_fin` |
| **Legacy** | `ssn` (alias for `us_ssn`) |
| **Custom** | `custom` (user-defined regex via `pattern` field) |

All patterns for a rule are combined into a single alternation regex at compile time for a single-pass replacement:

```json
{
  "filter": {
    "redact": [
      { "type": "email" },
      { "type": "phone" },
      { "type": "custom", "pattern": "\\bACCT-\\d{8}\\b", "replacement": "[ACCOUNT]" }
    ]
  }
}
```

Redacted values are replaced with `[REDACTED]` by default, or a custom replacement string.

## Compilation and Caching

Rules are compiled once when first accessed for a policy, then cached in-memory per Fastify replica. Cookie-based sticky sessions pin agents to replicas, so compile cost is amortized. Cache invalidation is broadcast to all replicas via PostgreSQL LISTEN/NOTIFY.

### What Gets Compiled

| Source | Compiled Form | Why |
|--------|--------------|-----|
| `methods` array | `Set<string>` | O(1) lookup instead of array scan |
| `urlPattern` string | `RegExp` | V8 compiles to native code |
| `body[].path` | `string[]` (split on `.`) | Fast object traversal |
| `in` / `not_in` values | `Set<string>` | O(1) membership check |
| `matches` / `contains` | `RegExp` | Pre-compiled, reused across requests |
| PII patterns | Single alternation `RegExp` | One regex instead of N separate passes |

### Cache Invalidation

The cache is invalidated when:

- A policy is updated via `PUT /v1/policies/:id` (explicit delete from cache)
- The Fastify replica restarts (cache is empty on boot)

No TTL-based expiry is needed. Explicit invalidation on policy mutation is deterministic, and LISTEN/NOTIFY broadcasts invalidation to all replicas.

## Performance

| Operation | Time | Notes |
|-----------|------|-------|
| Method check (`Set.has`) | ~10 ns | O(1) hash lookup |
| URL regex (`regex.test`) | 100-500 ns | V8 native code |
| Body field traversal (3-deep) | ~50 ns | Array index traversal |
| PII regex on 1KB string | 2-5 us | Single-pass alternation |
| Field filtering (10 fields) | 200-500 ns | `Object.entries` + `Set.has` |
| **Total request evaluation** | **< 5 us** | 3-5 rules, 1 body condition |
| **Total response filtering** | **< 10 us** | Field filter + PII redact on 1KB |
| **Combined overhead** | **< 15 us** | 0.003% of a 500ms provider call |

## Zod Schemas

The rule schemas are defined in `packages/contracts` for validation at write time:

```typescript title="packages/contracts/src/policy.ts"
export const BodyConditionSchema = z.object({
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "in", "not_in", "contains", "matches", "exists"]),
  value: z.union([
    z.string(), z.number(), z.boolean(), z.array(z.string()),
  ]).optional(),
});

export const RequestRuleSchema = z.object({
  label: z.string().optional(),
  match: z.object({
    methods: z.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"])).optional(),
    urlPattern: z.string().optional(),
    queryPattern: z.string().optional(),
    body: z.array(BodyConditionSchema).optional(),
    pii: PiiMatchConfigSchema.optional(),
  }),
  action: z.enum(["allow", "deny", "require_approval", "redact"]),
  /** PII redaction config -- only used when action is "redact". */
  redactConfig: RedactConfigSchema.optional(),
});

export const ResponseRuleSchema = z.object({
  label: z.string().optional(),
  match: z.object({
    urlPattern: z.string().optional(),
    queryPattern: z.string().optional(),
    methods: z.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"])).optional(),
  }),
  filter: z.object({
    allowFields: z.array(z.string()).optional(),
    denyFields: z.array(z.string()).optional(),
    redact: z.array(RedactPatternSchema).optional(),
  }),
});

export const PolicyRulesSchema = z.object({
  request: z.array(RequestRuleSchema).default([]),
  response: z.array(ResponseRuleSchema).default([]),
  fieldStepUpEnabled: z.boolean().optional(),
});
```

## Contextual Guards

Contextual guards are security controls organized by **what the agent is doing**, not which API it is calling. Each guard is a single toggle in the policy wizard that produces provider-specific rules when enabled.

### Why Guards

Provider-specific rule templates treat rules as API plumbing. A user does not think "I want to match `POST /v1.0/me/sendMail` with a body condition on `message.body.content`." They think "I want a profanity filter on outbound messages."

The same security concern (profanity, PII, audience limits) applies across providers -- only the URL patterns and body paths differ.

### Guard Categories

| Category | Description | Examples |
|----------|-------------|---------|
| **Content Safety** | Cross-cutting content inspection | Profanity filter, PII outbound guard, PII redaction |
| **Messaging** | Outbound message controls | Send approval, forward protection, attachment type guard |
| **File Sharing** | File upload/share controls | Public share block, external share guard, dangerous file types |
| **Calendar** | Event/invitation controls | External attendee guard, event cancellation guard |
| **Data Reading** | Response filtering | Contact PII stripping |
| **Destructive** | Delete/kick/ban controls | Delete protection, member removal protection |
| **Admin** | Role/settings controls | Settings change guard |

### How Guards Work

Each guard contains provider-specific rule implementations. When a guard is enabled for a provider, its request and response rules are merged into the policy's `rules` object. Multiple guards compose together -- the final rule ordering follows the firewall model.

```typescript
interface ContextualGuard {
  id: string;                    // e.g., "cs-profanity"
  category: GuardCategory;
  name: string;                  // e.g., "Profanity Filter"
  description: string;
  risk: "low" | "medium" | "high";
  presetTier: "standard" | "strict";
  providers: string[];
  rules: Record<string, {
    requestRules: RequestRule[];
    responseRules: ResponseRule[];
  }>;
}
```

### Presets and Guards

Presets (minimal / standard / strict) and guards are complementary:

1. **Step 2** of the policy wizard -- the user picks a preset (sets baseline rules)
2. **Step 3** -- the user toggles individual guards on/off (adds or removes specific rules)

Guards enabled by a preset are pre-selected in the wizard. The user can deselect them or enable additional guards beyond the preset.

### MVP Guard Inventory

| ID | Name | Category | Risk | Providers |
|----|------|----------|------|-----------|
| `cs-profanity` | Profanity Filter | Content Safety | High | MS, TG, SL |
| `cs-pii-outbound` | PII Outbound Guard | Content Safety | High | G, MS, TG, SL |
| `cs-pii-redact` | PII Response Redaction | Content Safety | Medium | G, MS, TG, SL |
| `msg-send-approval` | Send Approval | Messaging | Medium | G, MS, TG, SL |
| `msg-forward-block` | Forward Protection | Messaging | Medium | TG |
| `fs-public-share` | Block Public Sharing | File Sharing | High | G, MS |
| `fs-external-share` | External Sharing Guard | File Sharing | High | G, MS |
| `fs-dangerous-file` | Dangerous File Type Guard | File Sharing | High | G, MS |
| `cal-external-attendee` | External Attendee Guard | Calendar | High | G, MS |
| `dest-delete-protect` | Delete Protection | Destructive | High | G, MS, TG, SL |
| `adm-settings-guard` | Settings Change Guard | Admin | High | G, MS |

**G** = Google, **MS** = Microsoft, **TG** = Telegram, **SL** = Slack

:::tip
For the full guard matrix including all providers and body content paths, see the OpenClaw contextual rules documentation.
:::

## Audit Trail

When a request rule determines the action, the audit event includes the matched rule label:

```typescript
logExecutionDenied(sub, agentId, connectionId, {
  model: "B",
  method,
  url,
  reason: `Denied by policy rule: "${rule.label ?? "unnamed"}"`,
});
```

When response filtering is applied:

```typescript
logResponseFiltered(sub, agentId, connectionId, {
  model: "B",
  method,
  path: urlPath,
  rule: rule.label,
  fieldsRemoved: removedCount,
  redactionsApplied: redactCount,
});
```

All audit events are fire-and-forget (async) -- they never block the response.

## Migration Path

1. **Phase 1:** Add `rules` JSONB column with empty default. Implement engine with fallback to existing behavior
2. **Phase 2:** Create rule templates per provider (presets)
3. **Phase 3:** Build rule authoring UI (contextual guards wizard)
4. **Phase 4:** Deprecate legacy `stepUpApproval` enum in favor of rules (keep column for backward compatibility)

Phase 1 is zero-breaking-change: existing policies with empty rules behave identically to the current system.
