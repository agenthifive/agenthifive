/**
 * Policy Engine — compiled declarative rule engine for request evaluation
 * and response filtering.
 *
 * Pure functions with no external dependencies (DB, Fastify, etc).
 * Rules are compiled once per policy load, then evaluated per request.
 */

import type {
  PolicyRules,
  RequestRule,
  RequestRuleAction,
  ResponseRule,
  BodyCondition,
  RedactConfig,
} from "@agenthifive/contracts";
import { compilePiiRedactor, scanText, resolveRecognizers, type PiiRedactor, type Recognizer } from "./pii/index.js";

// ── Compiled types ─────────────────────────────────────────────────

interface CompiledBodyCondition {
  pathSegments: string[];
  op: string;
  value: unknown;
  valueSet: Set<string> | null;
  valueRegex: RegExp | null;
}

interface CompiledRedactConfig {
  /** Pre-compiled PII redactor for the "redact" action. */
  redactor: PiiRedactor;
  /** Resolved recognizers (needed for scanText to get entity types). */
  recognizers: Recognizer[];
  /** Parsed field paths for redaction. Each path is split into segments; "[*]" is a sentinel. */
  fieldPaths: string[][];
}

interface CompiledPiiMatchConfig {
  /** Resolved recognizers used to scan request fields. */
  recognizers: Recognizer[];
  /** Parsed field paths to scan. */
  fieldPaths: string[][];
}

interface CompiledRequestRule {
  label: string;
  methodSet: Set<string> | null;
  urlRegex: RegExp | null;
  queryRegex: RegExp | null;
  bodyConditions: CompiledBodyCondition[];
  action: RequestRuleAction;
  /** Present when request-side shared PII scanning is configured. */
  piiMatchConfig: CompiledPiiMatchConfig | null;
  /** Present only when action is "redact" and redactConfig compiled successfully. */
  redactConfig: CompiledRedactConfig | null;
}

interface CompiledResponseRule {
  label: string;
  urlRegex: RegExp | null;
  queryRegex: RegExp | null;
  methodSet: Set<string> | null;
  allowFieldSet: Set<string> | null;
  denyFieldSet: Set<string> | null;
  redactor: PiiRedactor | null;
}

export interface CompiledPolicyRules {
  request: CompiledRequestRule[];
  response: CompiledResponseRule[];
  compiledAt: number;
}

// ── In-memory cache (per-replica; invalidation broadcast via LISTEN/NOTIFY) ──

const cache = new Map<string, CompiledPolicyRules>();

export function getCompiledRules(
  policyId: string,
  rawRules: PolicyRules,
): CompiledPolicyRules {
  const cached = cache.get(policyId);
  if (cached) return cached;

  const compiled = compileRules(rawRules);
  cache.set(policyId, compiled);
  return compiled;
}

export function invalidatePolicyCache(policyId: string): void {
  cache.delete(policyId);
}

export function clearPolicyCache(): void {
  cache.clear();
}

// ── Compilation ────────────────────────────────────────────────────

export function compileRules(raw: PolicyRules): CompiledPolicyRules {
  return {
    request: raw.request.map(compileRequestRule),
    response: raw.response.map(compileResponseRule),
    compiledAt: Date.now(),
  };
}

function compileRequestRule(rule: RequestRule): CompiledRequestRule {
  return {
    label: rule.label ?? "",
    methodSet: rule.match.methods?.length
      ? new Set(rule.match.methods)
      : null,
    urlRegex: rule.match.urlPattern
      ? safeCompileRegex(rule.match.urlPattern)
      : null,
    queryRegex: rule.match.queryPattern
      ? safeCompileRegex(rule.match.queryPattern)
      : null,
    bodyConditions: (rule.match.body ?? []).map(compileBodyCondition),
    action: rule.action,
    piiMatchConfig: rule.match.pii
      ? compilePiiMatchConfig(rule.match.pii)
      : null,
    redactConfig: rule.action === "redact" && rule.redactConfig
      ? compileRedactConfig(rule.redactConfig)
      : null,
  };
}

function compilePiiMatchConfig(cfg: NonNullable<RequestRule["match"]["pii"]>): CompiledPiiMatchConfig | null {
  const builtInTypes = cfg.types.filter((t: { type: string }) => t.type !== "custom").map((t: { type: string }) => t.type);
  const recognizers = resolveRecognizers(builtInTypes);

  for (let i = 0; i < cfg.types.length; i++) {
    const t = cfg.types[i]!;
    if (t.type === "custom" && t.pattern) {
      try {
        recognizers.push({
          id: `custom_${i}`,
          patterns: [{ name: `custom_${i}`, regex: new RegExp(t.pattern, "g"), score: 0.6 }],
          contextWords: [],
        });
      } catch { /* invalid regex — skip */ }
    }
  }

  if (recognizers.length === 0) return null;

  return {
    recognizers,
    fieldPaths: cfg.fields.map(parseFieldPath),
  };
}

function compileRedactConfig(cfg: RedactConfig): CompiledRedactConfig | null {
  const builtInTypes = cfg.types.filter(t => t.type !== "custom").map(t => t.type);
  const recognizers = resolveRecognizers(builtInTypes);

  // Add custom regex recognizers
  for (let i = 0; i < cfg.types.length; i++) {
    const t = cfg.types[i]!;
    if (t.type === "custom" && t.pattern) {
      try {
        recognizers.push({
          id: `custom_${i}`,
          patterns: [{ name: `custom_${i}`, regex: new RegExp(t.pattern, "g"), score: 0.6 }],
          contextWords: [],
        });
      } catch { /* invalid regex — skip */ }
    }
  }

  if (recognizers.length === 0) return null;

  const redactor = compilePiiRedactor(cfg.types, { replacement: "[PII_REDACTED]" });
  if (!redactor) return null;

  // Parse field paths: "messages[*].content" → ["messages", "[*]", "content"]
  const fieldPaths = cfg.fields.map(parseFieldPath);

  return { redactor, recognizers, fieldPaths };
}

/**
 * Parse a field path string into segments.
 * "messages[*].content" → ["messages", "[*]", "content"]
 * "contents[*].parts[*].text" → ["contents", "[*]", "parts", "[*]", "text"]
 * "system" → ["system"]
 */
function parseFieldPath(path: string): string[] {
  const segments: string[] = [];
  for (const part of path.split(".")) {
    const arrayIdx = part.indexOf("[*]");
    if (arrayIdx >= 0) {
      if (arrayIdx > 0) segments.push(part.slice(0, arrayIdx));
      segments.push("[*]");
      const rest = part.slice(arrayIdx + 3);
      if (rest.length > 0) segments.push(rest);
    } else {
      segments.push(part);
    }
  }
  return segments;
}

function compileBodyCondition(cond: BodyCondition): CompiledBodyCondition {
  let valueSet: Set<string> | null = null;
  let valueRegex: RegExp | null = null;

  if ((cond.op === "in" || cond.op === "not_in") && Array.isArray(cond.value)) {
    valueSet = new Set(cond.value.map(String));
  }

  if (cond.op === "matches" && typeof cond.value === "string") {
    valueRegex = safeCompileRegex(cond.value);
  }

  if (cond.op === "contains" && typeof cond.value === "string") {
    // Escape the value for literal substring match
    const escaped = cond.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    valueRegex = new RegExp(escaped, "i");
  }

  return {
    pathSegments: cond.path.split("."),
    op: cond.op,
    value: cond.value,
    valueSet,
    valueRegex,
  };
}

function compileResponseRule(rule: ResponseRule): CompiledResponseRule {
  return {
    label: rule.label ?? "",
    urlRegex: rule.match.urlPattern
      ? safeCompileRegex(rule.match.urlPattern)
      : null,
    queryRegex: rule.match.queryPattern
      ? safeCompileRegex(rule.match.queryPattern)
      : null,
    methodSet: rule.match.methods?.length
      ? new Set(rule.match.methods)
      : null,
    allowFieldSet: rule.filter.allowFields?.length
      ? new Set(rule.filter.allowFields)
      : null,
    denyFieldSet: rule.filter.denyFields?.length
      ? new Set(rule.filter.denyFields)
      : null,
    redactor: compilePiiRedactor(rule.filter.redact ?? []),
  };
}

/**
 * Parse a regex string, converting PCRE-style `(?i)` prefix to JS `i` flag.
 * Returns { pattern, flags } ready for `new RegExp(pattern, flags)`.
 */
function parseRegexFlags(raw: string): { pattern: string; flags: string } {
  if (raw.startsWith("(?i)")) {
    return { pattern: raw.slice(4), flags: "i" };
  }
  return { pattern: raw, flags: "" };
}

function safeCompileRegex(pattern: string): RegExp | null {
  try {
    const { pattern: p, flags } = parseRegexFlags(pattern);
    return new RegExp(p, flags);
  } catch {
    return null;
  }
}

// ── Request Evaluation ─────────────────────────────────────────────

export type RuleAction = RequestRuleAction;

/** Metadata about a single PII redaction performed on the request body. */
export interface RedactionInfo {
  /** PII entity type (e.g., "us_ssn", "credit_card"). */
  type: string;
  /** JSON field path where PII was found (e.g., "messages[1].content"). */
  field: string;
  /** Number of replacements in this field. */
  count: number;
}

export interface EvaluationResult {
  action: RuleAction;
  label: string;
  /** Number of rules evaluated before match (or total if no match). Debug tracing. */
  rulesChecked: number;
  /** Ordered trace of rule evaluations: "label:skip(reason)" or "label:MATCH(action)". */
  trace: string[];
  /** When action is "redact": the modified request body with PII replaced. */
  redactedBody?: unknown;
  /** When action is "redact": metadata about what was redacted. */
  redactions?: RedactionInfo[];
  /** Structured match metadata for approvals/audit UI. */
  guardMatches?: Array<{ patternType: string; field: string; excerpt: string }>;
}

/**
 * Evaluate request rules. Returns the action from the first matching rule,
 * or null if no rule matched (caller should fall back to existing logic).
 *
 * @param queryString - The URL query string (e.g. "?alt=media&fields=id").
 *   Optional for backwards compat; defaults to "" (matches no queryPattern).
 */
export function evaluateRequestRules(
  rules: CompiledRequestRule[],
  method: string,
  urlPath: string,
  body: unknown,
  queryString = "",
): EvaluationResult | null {
  const trace: string[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    const label = rule.label || `rule[${i}]`;

    if (rule.methodSet && !rule.methodSet.has(method)) { trace.push(`${label}:skip(method)`); continue; }
    if (rule.urlRegex && !rule.urlRegex.test(urlPath)) { trace.push(`${label}:skip(url)`); continue; }
    if (rule.queryRegex && !rule.queryRegex.test(queryString)) { trace.push(`${label}:skip(query)`); continue; }

    if (rule.bodyConditions.length > 0) {
      if (typeof body !== "object" || body === null) { trace.push(`${label}:skip(body-type)`); continue; }
      if (!evaluateAllBodyConditions(rule.bodyConditions, body)) { trace.push(`${label}:skip(body-cond)`); continue; }
    }

    let guardMatches: EvaluationResult["guardMatches"];
    if (rule.piiMatchConfig) {
      if (body === null || body === undefined || (typeof body !== "object" && typeof body !== "string")) {
        trace.push(`${label}:skip(pii-body-type)`);
        continue;
      }
      guardMatches = detectPiiInRequestBody(body, rule.piiMatchConfig);
      if (!guardMatches || guardMatches.length === 0) {
        trace.push(`${label}:skip(pii)`);
        continue;
      }
    }

    trace.push(`${label}:MATCH(${rule.action})`);

    // For "redact" action: perform PII redaction on the request body
    if (rule.action === "redact" && rule.redactConfig && body) {
      const { redactedBody, redactions } = redactRequestBody(body, rule.redactConfig);
      if (redactions.length > 0) {
        const result: EvaluationResult = {
          action: "redact",
          label: rule.label,
          rulesChecked: i + 1,
          trace,
          redactedBody,
          redactions,
        };
        if (guardMatches) result.guardMatches = guardMatches;
        return result;
      }
      // No PII actually found despite the detection regex matching — treat as allow
      trace[trace.length - 1] = `${label}:MATCH(redact→allow, no PII found)`;
      return { action: "allow", label: rule.label, rulesChecked: i + 1, trace };
    }

    const result: EvaluationResult = {
      action: rule.action,
      label: rule.label,
      rulesChecked: i + 1,
      trace,
    };
    if (guardMatches) result.guardMatches = guardMatches;
    return result;
  }

  return null;
}

function detectPiiInRequestBody(
  body: unknown,
  config: CompiledPiiMatchConfig,
): Array<{ patternType: string; field: string; excerpt: string }> {
  const matches: Array<{ patternType: string; field: string; excerpt: string }> = [];
  for (const fieldPath of config.fieldPaths) {
    walkAndDetectPii(body, fieldPath, 0, "", config.recognizers, matches);
  }
  return matches;
}

function evaluateAllBodyConditions(
  conditions: CompiledBodyCondition[],
  body: unknown,
): boolean {
  for (const cond of conditions) {
    if (!evaluateBodyCondition(cond, body)) return false;
  }
  return true;
}

function evaluateBodyCondition(
  cond: CompiledBodyCondition,
  body: unknown,
): boolean {
  const value = resolveFieldValue(body, cond.pathSegments);

  switch (cond.op) {
    case "exists":
      return value !== undefined;
    case "eq":
      return value === cond.value;
    case "neq":
      return value !== cond.value;
    case "in":
      return cond.valueSet !== null && cond.valueSet.has(String(value));
    case "not_in":
      return cond.valueSet !== null && !cond.valueSet.has(String(value));
    case "contains":
      return (
        typeof value === "string" &&
        cond.valueRegex !== null &&
        cond.valueRegex.test(value)
      );
    case "matches":
      return (
        typeof value === "string" &&
        cond.valueRegex !== null &&
        cond.valueRegex.test(value)
      );
    default:
      return false;
  }
}

function resolveFieldValue(obj: unknown, segments: string[]): unknown {
  // $body: return the entire body as a JSON string for full-payload matching
  if (segments.length === 1 && segments[0] === "$body") {
    return typeof obj === "string" ? obj : JSON.stringify(obj);
  }
  // $prompt_text: extract only prompt-bearing user/system text and ignore
  // assistant/model history so quoted examples do not keep retriggering guards.
  if (segments.length === 1 && segments[0] === "$prompt_text") {
    return extractPromptText(obj);
  }

  let current = obj;
  for (const seg of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

export function extractPromptText(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(extractPromptText).filter(Boolean).join("\n");
  if (typeof obj !== "object") return "";

  const record = obj as Record<string, unknown>;
  const chunks: string[] = [];

  const system = record.system;
  if (typeof system === "string") {
    chunks.push(system);
  } else if (Array.isArray(system)) {
    chunks.push(extractPromptText(system));
  }

  const messages = record.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (typeof msg !== "object" || msg === null || Array.isArray(msg)) continue;
      const rec = msg as Record<string, unknown>;
      const role = typeof rec.role === "string" ? rec.role.toLowerCase() : "";
      if (role === "assistant") continue;
      chunks.push(extractPromptText(rec.content));
    }
  }

  const input = record.input;
  if (typeof input === "string") {
    chunks.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        chunks.push(extractPromptText(item));
        continue;
      }
      const rec = item as Record<string, unknown>;
      const role = typeof rec.role === "string" ? rec.role.toLowerCase() : "";
      if (role === "assistant" || role === "model") continue;
      chunks.push(extractPromptText(rec.content));
      chunks.push(extractPromptText(rec.input_text));
      chunks.push(extractPromptText(rec.text));
    }
  }

  const contents = record.contents;
  if (Array.isArray(contents)) {
    for (const item of contents) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const role = typeof rec.role === "string" ? rec.role.toLowerCase() : "";
      if (role === "model") continue;
      chunks.push(extractPromptText(rec.parts));
    }
  }

  const systemInstruction = record.systemInstruction;
  if (typeof systemInstruction === "object" && systemInstruction !== null && !Array.isArray(systemInstruction)) {
    chunks.push(extractPromptText((systemInstruction as Record<string, unknown>).parts));
  }

  const text = record.text;
  if (typeof text === "string") chunks.push(text);

  const content = record.content;
  if (typeof content === "string") {
    chunks.push(content);
  } else if (Array.isArray(content)) {
    chunks.push(extractPromptText(content));
  }

  const parts = record.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (typeof part === "string") {
        chunks.push(part);
      } else if (typeof part === "object" && part !== null && !Array.isArray(part)) {
        const rec = part as Record<string, unknown>;
        if (typeof rec.text === "string") chunks.push(rec.text);
      }
    }
  }

  return chunks.filter(Boolean).join("\n");
}

// ── Request-side PII Redaction ─────────────────────────────────────

/**
 * Walk specified field paths in the request body, scan for PII, and replace
 * matches with typed placeholders like `[PII_REDACTED:us_ssn]`.
 *
 * Returns a deep clone with PII replaced, plus metadata about what was redacted.
 */
function redactRequestBody(
  body: unknown,
  config: CompiledRedactConfig,
): { redactedBody: unknown; redactions: RedactionInfo[] } {
  const cloned = JSON.parse(JSON.stringify(body));
  const redactions: RedactionInfo[] = [];

  for (const fieldPath of config.fieldPaths) {
    walkAndRedact(cloned, fieldPath, 0, "", config.recognizers, redactions);
  }

  return { redactedBody: cloned, redactions };
}

/**
 * Recursively walk the field path and redact PII in leaf string values.
 *
 * Handles:
 * - Simple keys: "system" → obj.system
 * - Array wildcards: "[*]" → iterate all array elements
 * - Anthropic content blocks: if a "content" field is an array of objects
 *   with {type: "text", text: "..."}, walks into the "text" fields
 */
function walkAndRedact(
  obj: unknown,
  pathSegments: string[],
  segIndex: number,
  fieldPrefix: string,
  recognizers: Recognizer[],
  redactions: RedactionInfo[],
): void {
  if (obj === null || obj === undefined) return;

  // Reached the leaf — this value should be scanned for PII
  if (segIndex >= pathSegments.length) {
    if (typeof obj === "string") {
      // This shouldn't happen — we need the parent to do the replacement
      return;
    }
    return;
  }

  const segment = pathSegments[segIndex]!;

  if (segment === "[*]") {
    // Array wildcard — iterate
    if (!Array.isArray(obj)) return;
    for (let i = 0; i < obj.length; i++) {
      const elemPrefix = `${fieldPrefix}[${i}]`;
      if (segIndex + 1 >= pathSegments.length) {
        // Leaf: the array element itself should be scanned
        if (typeof obj[i] === "string") {
          const result = scanAndReplace(obj[i] as string, recognizers);
          if (result.count > 0) {
            obj[i] = result.text;
            redactions.push(...result.redactions.map(r => ({ ...r, field: elemPrefix })));
          }
        } else if (Array.isArray(obj[i])) {
          // Anthropic: content can be array of {type:"text",text:"..."}
          redactContentBlocks(obj[i] as unknown[], elemPrefix, recognizers, redactions);
        }
      } else {
        walkAndRedact(obj[i], pathSegments, segIndex + 1, elemPrefix, recognizers, redactions);
      }
    }
    return;
  }

  // Named key
  if (typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;
  const value = record[segment];
  const currentPath = fieldPrefix ? `${fieldPrefix}.${segment}` : segment;

  if (value === undefined) return;

  if (segIndex + 1 >= pathSegments.length) {
    // Leaf — scan and replace
    if (typeof value === "string") {
      const result = scanAndReplace(value, recognizers);
      if (result.count > 0) {
        record[segment] = result.text;
        redactions.push(...result.redactions.map(r => ({ ...r, field: currentPath })));
      }
    } else if (Array.isArray(value)) {
      // Anthropic: messages[].content can be an array of content blocks
      redactContentBlocks(value, currentPath, recognizers, redactions);
    }
  } else {
    walkAndRedact(value, pathSegments, segIndex + 1, currentPath, recognizers, redactions);
  }
}

function walkAndDetectPii(
  obj: unknown,
  pathSegments: string[],
  segIndex: number,
  fieldPrefix: string,
  recognizers: Recognizer[],
  matches: Array<{ patternType: string; field: string; excerpt: string }>,
): void {
  if (obj === null || obj === undefined) return;

  if (segIndex >= pathSegments.length) {
    return;
  }

  const segment = pathSegments[segIndex]!;

  if (segment === "$body" && pathSegments.length === 1) {
    const target = typeof obj === "string" ? obj : JSON.stringify(obj);
    matches.push(...scanForGuardMatches(target, "$body", recognizers));
    return;
  }

  if (segment === "[*]") {
    if (!Array.isArray(obj)) return;
    for (let i = 0; i < obj.length; i++) {
      const elemPrefix = `${fieldPrefix}[${i}]`;
      if (segIndex + 1 >= pathSegments.length) {
        if (typeof obj[i] === "string") {
          matches.push(...scanForGuardMatches(obj[i] as string, elemPrefix, recognizers));
        } else if (Array.isArray(obj[i])) {
          detectContentBlocks(obj[i] as unknown[], elemPrefix, recognizers, matches);
        }
      } else {
        walkAndDetectPii(obj[i], pathSegments, segIndex + 1, elemPrefix, recognizers, matches);
      }
    }
    return;
  }

  if (typeof obj !== "object") return;
  const record = obj as Record<string, unknown>;
  const value = record[segment];
  const currentPath = fieldPrefix ? `${fieldPrefix}.${segment}` : segment;

  if (value === undefined) return;

  if (segIndex + 1 >= pathSegments.length) {
    if (typeof value === "string") {
      matches.push(...scanForGuardMatches(value, currentPath, recognizers));
    } else if (Array.isArray(value)) {
      detectContentBlocks(value, currentPath, recognizers, matches);
    }
  } else {
    walkAndDetectPii(value, pathSegments, segIndex + 1, currentPath, recognizers, matches);
  }
}

/**
 * Handle Anthropic-style content blocks: [{type: "text", text: "..."}, {type: "image", ...}]
 * Only redacts "text" fields in blocks with type === "text".
 */
function redactContentBlocks(
  blocks: unknown[],
  fieldPrefix: string,
  recognizers: Recognizer[],
  redactions: RedactionInfo[],
): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (typeof block === "object" && block !== null && !Array.isArray(block)) {
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        const result = scanAndReplace(rec.text, recognizers);
        if (result.count > 0) {
          rec.text = result.text;
          redactions.push(...result.redactions.map(r => ({ ...r, field: `${fieldPrefix}[${i}].text` })));
        }
      }
    } else if (typeof block === "string") {
      // Plain string in content array
      const result = scanAndReplace(block, recognizers);
      if (result.count > 0) {
        blocks[i] = result.text;
        redactions.push(...result.redactions.map(r => ({ ...r, field: `${fieldPrefix}[${i}]` })));
      }
    }
  }
}

function detectContentBlocks(
  blocks: unknown[],
  fieldPrefix: string,
  recognizers: Recognizer[],
  matches: Array<{ patternType: string; field: string; excerpt: string }>,
): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (typeof block === "object" && block !== null && !Array.isArray(block)) {
      const rec = block as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        matches.push(...scanForGuardMatches(rec.text, `${fieldPrefix}[${i}].text`, recognizers));
      }
    } else if (typeof block === "string") {
      matches.push(...scanForGuardMatches(block, `${fieldPrefix}[${i}]`, recognizers));
    }
  }
}

function scanForGuardMatches(
  text: string,
  field: string,
  recognizers: Recognizer[],
): Array<{ patternType: string; field: string; excerpt: string }> {
  const entities = scanText(text, recognizers);
  return entities.map((entity) => {
    const start = Math.max(0, entity.start - 40);
    const end = Math.min(text.length, entity.end + 40);
    return {
      patternType: entity.type,
      field,
      excerpt: (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : ""),
    };
  });
}

/**
 * Scan a string for PII entities and replace each with a typed placeholder.
 * Returns the modified text and per-type redaction counts.
 */
function scanAndReplace(
  text: string,
  recognizers: Recognizer[],
): { text: string; count: number; redactions: RedactionInfo[] } {
  const entities = scanText(text, recognizers);
  if (entities.length === 0) {
    return { text, count: 0, redactions: [] };
  }

  // Sort by start position descending so replacements don't shift offsets
  entities.sort((a, b) => b.start - a.start);

  // Count per type
  const typeCounts = new Map<string, number>();
  let result = text;
  for (const entity of entities) {
    result = result.slice(0, entity.start) + `[PII_REDACTED:${entity.type}]` + result.slice(entity.end);
    typeCounts.set(entity.type, (typeCounts.get(entity.type) ?? 0) + 1);
  }

  const redactions: RedactionInfo[] = [];
  for (const [type, count] of typeCounts) {
    redactions.push({ type, count, field: "" }); // field set by caller
  }

  return { text: result, count: entities.length, redactions };
}

// ── Response Filtering ─────────────────────────────────────────────

/**
 * Apply ALL matching response rules (merge-all semantics).
 *
 * Guards are designed to compose: one guard strips fields, another redacts PII.
 * Each matching rule's effects are applied sequentially — denyFields are unioned,
 * redactors are chained, allowFields narrow progressively.
 *
 * @param queryString - The URL query string. Optional; defaults to "".
 */
export function filterResponse(
  rules: CompiledResponseRule[],
  method: string,
  urlPath: string,
  body: unknown,
  queryString = "",
): unknown {
  if (typeof body !== "object" || body === null) return body;

  let filtered: unknown = body;
  let matched = false;

  for (const rule of rules) {
    if (rule.methodSet && !rule.methodSet.has(method)) continue;
    if (rule.urlRegex && !rule.urlRegex.test(urlPath)) continue;
    if (rule.queryRegex && !rule.queryRegex.test(queryString)) continue;

    matched = true;

    if (rule.allowFieldSet) {
      filtered = pickFields(filtered, rule.allowFieldSet);
    } else if (rule.denyFieldSet) {
      filtered = omitFields(filtered, rule.denyFieldSet);
    }

    if (rule.redactor) {
      filtered = redactStrings(filtered, rule.redactor);
    }
  }

  return filtered;
}

function pickFields(obj: unknown, fields: Set<string>): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => pickFields(item, fields));
  }
  if (typeof obj !== "object" || obj === null) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (fields.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function omitFields(obj: unknown, fields: Set<string>): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => omitFields(item, fields));
  }
  if (typeof obj !== "object" || obj === null) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!fields.has(key)) {
      // Recurse into nested objects/arrays to strip denied fields at all depths
      result[key] = (typeof value === "object" && value !== null)
        ? omitFields(value, fields)
        : value;
    }
  }
  return result;
}

// Minimum length for a string to be worth trying base64 decode (short
// strings are unlikely to be encoded payloads and decoding them wastes cycles).
const BASE64_MIN_LENGTH = 40;

// Matches standard base64 and base64url character sets.
const BASE64_CHARSET_RE = /^[A-Za-z0-9+/\-_]+=*$/;

/**
 * Try to decode a base64/base64url string to UTF-8.
 * Returns the decoded text if it looks like valid UTF-8 text, null otherwise.
 */
function tryDecodeBase64(str: string): string | null {
  if (str.length < BASE64_MIN_LENGTH) return null;
  if (!BASE64_CHARSET_RE.test(str)) return null;
  try {
    // Convert base64url to standard base64
    const std = str.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(std, "base64");
    // Reject binary content — if >5% of bytes are non-printable, it's not text
    let nonPrintable = 0;
    for (let i = 0; i < Math.min(buf.length, 512); i++) {
      const b = buf[i]!;
      if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) nonPrintable++;
    }
    const sampleSize = Math.min(buf.length, 512);
    if (sampleSize > 0 && nonPrintable / sampleSize > 0.05) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Re-encode text to base64url (matching Gmail API format: no padding, URL-safe).
 */
function encodeBase64Url(text: string): string {
  return Buffer.from(text, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function redactStrings(
  obj: unknown,
  redactor: PiiRedactor,
): unknown {
  if (typeof obj === "string") {
    const redacted = redactor.redact(obj);

    // If the string wasn't changed, try decoding it as base64 (Gmail, etc.)
    if (redacted === obj) {
      const decoded = tryDecodeBase64(obj);
      if (decoded) {
        const redactedDecoded = redactor.redact(decoded);
        if (redactedDecoded !== decoded) {
          return encodeBase64Url(redactedDecoded);
        }
      }
    }

    return redacted;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactStrings(item, redactor));
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactStrings(value, redactor);
    }
    return result;
  }
  return obj;
}

// ── Validation helper ──────────────────────────────────────────────

/**
 * Validate that all regex patterns in the rules compile safely.
 * Returns null if valid, or an error message string.
 */
export function validateRules(rules: PolicyRules): string | null {
  for (let i = 0; i < rules.request.length; i++) {
    const reqRule = rules.request[i]!;
    if (reqRule.match.urlPattern) {
      try {
        const { pattern, flags } = parseRegexFlags(reqRule.match.urlPattern);
        new RegExp(pattern, flags);
      } catch (e) {
        return `request[${i}].match.urlPattern: invalid regex — ${(e as Error).message}`;
      }
    }
    if (reqRule.match.queryPattern) {
      try {
        const { pattern, flags } = parseRegexFlags(reqRule.match.queryPattern);
        new RegExp(pattern, flags);
      } catch (e) {
        return `request[${i}].match.queryPattern: invalid regex — ${(e as Error).message}`;
      }
    }
    for (const p of reqRule.match.pii?.types ?? []) {
      if (p.type === "custom" && p.pattern) {
        try {
          const { pattern, flags } = parseRegexFlags(p.pattern);
          new RegExp(pattern, flags);
        } catch (e) {
          return `request[${i}].match.pii custom pattern: invalid regex — ${(e as Error).message}`;
        }
      }
    }
    for (const cond of reqRule.match.body ?? []) {
      if (cond.op === "matches" && typeof cond.value === "string") {
        try {
          const { pattern, flags } = parseRegexFlags(cond.value);
          new RegExp(pattern, flags);
        } catch (e) {
          return `request[${i}].match.body "${cond.path}": invalid regex — ${(e as Error).message}`;
        }
      }
    }
  }

  for (let i = 0; i < rules.response.length; i++) {
    const resRule = rules.response[i]!;
    if (resRule.match.urlPattern) {
      try {
        const { pattern, flags } = parseRegexFlags(resRule.match.urlPattern);
        new RegExp(pattern, flags);
      } catch (e) {
        return `response[${i}].match.urlPattern: invalid regex — ${(e as Error).message}`;
      }
    }
    if (resRule.match.queryPattern) {
      try {
        const { pattern, flags } = parseRegexFlags(resRule.match.queryPattern);
        new RegExp(pattern, flags);
      } catch (e) {
        return `response[${i}].match.queryPattern: invalid regex — ${(e as Error).message}`;
      }
    }
    if (resRule.filter.allowFields && resRule.filter.denyFields) {
      return `response[${i}]: allowFields and denyFields are mutually exclusive`;
    }
    for (const p of resRule.filter.redact ?? []) {
      if (p.type === "custom" && p.pattern) {
        try {
          const { pattern, flags } = parseRegexFlags(p.pattern);
          new RegExp(pattern, flags);
        } catch (e) {
          return `response[${i}].filter.redact custom pattern: invalid regex — ${(e as Error).message}`;
        }
      }
    }
  }

  return null;
}
