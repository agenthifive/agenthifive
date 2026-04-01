/**
 * India-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/india/.
 */

import type { Recognizer } from "../types.js";
import { verhoeff, extractDigits } from "../checksums.js";

// ── India Aadhaar ────────────────────────────────────────────────────────

export const inAadhaarRecognizer: Recognizer = {
  id: "in_aadhaar",
  patterns: [
    {
      name: "aadhaar_spaced",
      regex: /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g,
      score: 0.3,
    },
    {
      name: "aadhaar_contiguous",
      regex: /\b\d{12}\b/g,
      score: 0.01, // Extremely low — 12 random digits
    },
  ],
  contextWords: ["aadhaar", "uidai", "aadhar", "uid", "unique identification"],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 12) return false;
    // First digit must be >= 2
    if (digits[0]! < 2) return false;
    // Must not be a palindrome
    const str = digits.join("");
    const reversed = [...digits].reverse().join("");
    if (str === reversed) return false;
    // Verhoeff checksum
    return verhoeff(str) ? true : false;
  },
};

// ── India PAN ────────────────────────────────────────────────────────────

const VALID_PAN_ENTITY_TYPES = new Set([
  "C", // Company
  "P", // Person
  "H", // Hindu Undivided Family
  "F", // Firm
  "A", // Association of Persons
  "T", // Trust
  "B", // Body of Individuals
  "L", // Local Authority
  "J", // Artificial Juridical Person
  "G", // Government
]);

export const inPanRecognizer: Recognizer = {
  id: "in_pan",
  patterns: [
    {
      name: "pan",
      regex: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "pan", "permanent account", "income tax", "pan card",
    "permanent account number",
  ],
  validate(match: string): boolean | null {
    const upper = match.toUpperCase();
    // 4th character must be a valid entity type
    const entityType = upper[3]!;
    return VALID_PAN_ENTITY_TYPES.has(entityType) ? null : false;
  },
};
