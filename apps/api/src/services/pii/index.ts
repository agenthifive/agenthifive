/**
 * PII Detection Engine — Public API
 *
 * Presidio-inspired PII detection with regex patterns, checksum validation,
 * and context word scoring. Supports 40+ entity types across 12 countries.
 *
 * Usage:
 *   import { compilePiiRedactor } from "./pii";
 *
 *   const redactor = compilePiiRedactor(
 *     [{ type: "email" }, { type: "phone" }, { type: "credit_card" }],
 *   );
 *   if (redactor) {
 *     const safe = redactor.redact("Call me at +39 348 384 6623");
 *     // → "Call me at [REDACTED]"
 *   }
 */

import type { PiiRedactor } from "./types.js";
import { resolveRecognizers } from "./recognizers/index.js";
import { createRedactor, scanText } from "./scanner.js";

export type { PiiRedactor, PiiEntity, Recognizer } from "./types.js";
export { scanText } from "./scanner.js";
export { resolveRecognizers } from "./recognizers/index.js";

interface RedactPatternInput {
  type: string;
  pattern?: string | undefined;
  replacement?: string | undefined;
}

interface CompileOptions {
  threshold?: number;
  replacement?: string;
}

/**
 * Compile a set of redact patterns into a PiiRedactor.
 * Returns null if no valid recognizers could be resolved.
 *
 * This replaces the old `compileRedactRegex()` in policy-engine.ts.
 */
export function compilePiiRedactor(
  patterns: RedactPatternInput[],
  options?: CompileOptions,
): PiiRedactor | null {
  if (patterns.length === 0) return null;

  const replacement = options?.replacement ??
    patterns[0]?.replacement ??
    "[REDACTED]";

  // Separate built-in types from custom regex
  const builtInTypes: string[] = [];
  const customRegexes: RegExp[] = [];

  for (const p of patterns) {
    if (p.type === "custom" && p.pattern) {
      try {
        customRegexes.push(new RegExp(p.pattern, "g"));
      } catch {
        // Invalid regex — skip
      }
    } else {
      builtInTypes.push(p.type);
    }
  }

  // Resolve built-in types to recognizers
  const recognizers = resolveRecognizers(builtInTypes);

  // Add custom regex as ad-hoc recognizers
  for (let i = 0; i < customRegexes.length; i++) {
    recognizers.push({
      id: `custom_${i}`,
      patterns: [{ name: `custom_${i}`, regex: customRegexes[i]!, score: 0.6 }],
      contextWords: [],
    });
  }

  if (recognizers.length === 0) return null;

  return createRedactor(recognizers, replacement, options?.threshold);
}
