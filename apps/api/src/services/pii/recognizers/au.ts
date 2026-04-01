/**
 * Australia-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/australia/.
 */

import type { Recognizer } from "../types.js";
import { extractDigits, mod11, mod89 } from "../checksums.js";

// ── Australia TFN (Tax File Number) ──────────────────────────────────────

export const auTfnRecognizer: Recognizer = {
  id: "au_tfn",
  patterns: [
    {
      name: "tfn_spaced",
      regex: /\b\d{3}\s\d{3}\s\d{3}\b/g,
      score: 0.1,
    },
    {
      name: "tfn_contiguous",
      regex: /\b\d{9}\b/g,
      score: 0.01,
    },
  ],
  contextWords: ["tax file number", "tfn", "tax file", "australian tax"],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 9) return false;
    const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
    return mod11(digits, weights) ? true : false;
  },
};

// ── Australia ABN (Australian Business Number) ───────────────────────────

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export const auAbnRecognizer: Recognizer = {
  id: "au_abn",
  patterns: [
    {
      name: "abn_spaced",
      regex: /\b\d{2}\s\d{3}\s\d{3}\s\d{3}\b/g,
      score: 0.3,
    },
    {
      name: "abn_contiguous",
      regex: /\b\d{11}\b/g,
      score: 0.05,
    },
  ],
  contextWords: ["abn", "business number", "australian business"],
  validate(match: string): boolean | null {
    return mod89(match, ABN_WEIGHTS) ? true : false;
  },
};
