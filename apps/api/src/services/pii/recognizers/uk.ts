/**
 * UK-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/uk/.
 */

import type { Recognizer } from "../types.js";
import { extractDigits, mod11 } from "../checksums.js";

// ── UK NHS Number ────────────────────────────────────────────────────────

export const ukNhsRecognizer: Recognizer = {
  id: "uk_nhs",
  patterns: [
    {
      name: "nhs_spaced",
      regex: /\b\d{3}\s\d{3}\s\d{4}\b/g,
      score: 0.5,
    },
    {
      name: "nhs_contiguous",
      regex: /\b\d{10}\b/g,
      score: 0.05,
    },
  ],
  contextWords: ["nhs", "national health", "health service", "nhs number"],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 10) return false;
    // Weighted mod-11: weights 10,9,8,7,6,5,4,3,2 for first 9, check digit is 10th
    const weights = [10, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += digits[i]! * weights[i]!;
    }
    const remainder = sum % 11;
    const check = 11 - remainder;
    if (check === 11) return digits[9] === 0 ? null : false;
    if (check === 10) return false; // Invalid
    return digits[9] === check ? null : false;
  },
};

// ── UK NINO (National Insurance Number) ──────────────────────────────────

const NINO_INVALID_PREFIXES = new Set(["BG", "GB", "NK", "KN", "NT", "TN", "ZZ"]);

export const ukNinoRecognizer: Recognizer = {
  id: "uk_nino",
  patterns: [
    {
      name: "nino_spaced",
      regex: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g,
      score: 0.5,
    },
  ],
  contextWords: [
    "national insurance", "ni number", "nino", "insurance number",
    "national insurance number",
  ],
  validate(match: string): boolean | null {
    const cleaned = match.replace(/\s/g, "").toUpperCase();
    const prefix = cleaned.slice(0, 2);
    if (NINO_INVALID_PREFIXES.has(prefix)) return false;
    return null;
  },
};
