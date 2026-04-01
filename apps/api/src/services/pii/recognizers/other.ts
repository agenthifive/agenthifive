/**
 * Other country-specific PII recognizers.
 * Poland, Finland, Thailand, Korea, Singapore.
 * Ported from Presidio's predefined_recognizers/country_specific/.
 */

import type { Recognizer } from "../types.js";
import { extractDigits, weightedMod10, finnishPicCheck } from "../checksums.js";

// ── Poland PESEL ─────────────────────────────────────────────────────────

export const plPeselRecognizer: Recognizer = {
  id: "pl_pesel",
  patterns: [
    {
      name: "pesel",
      // Month encoding: 01-12 for 1900s, 21-32 for 2000s, etc.
      regex: /\b\d{2}([02468][1-9]|[13579][012])(0[1-9]|[12]\d|3[01])\d{5}\b/g,
      score: 0.4,
    },
  ],
  contextWords: ["pesel", "polish id", "polish national"],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 11) return false;
    const weights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
    return weightedMod10(digits, weights) ? true : false;
  },
};

// ── Finland Personal Identity Code ───────────────────────────────────────

export const fiPicRecognizer: Recognizer = {
  id: "fi_pic",
  patterns: [
    {
      name: "finnish_pic",
      regex: /\b\d{6}[+\-ABCDEFYXWVU]\d{3}[0-9A-Z]\b/g,
      score: 0.5,
    },
  ],
  contextWords: [
    "hetu", "henkilötunnus", "henkilotunnus", "personbeteckning",
    "personal identity code", "finnish id",
  ],
  validate(match: string): boolean | null {
    return finnishPicCheck(match) ? true : false;
  },
};

// ── Thailand TNIN (Thai National Identification Number) ──────────────────

export const thTninRecognizer: Recognizer = {
  id: "th_tnin",
  patterns: [
    {
      name: "tnin",
      regex: /\b[1-9]\d{12}\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "thai national id", "tnin", "thai citizen id",
    "เลขประจำตัวประชาชน", "บัตรประชาชน",
  ],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 13) return false;
    // Weight: 13-i for position i (0-indexed), check digit is last
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += (13 - i) * digits[i]!;
    }
    const check = (11 - (sum % 11)) % 10;
    return check === digits[12] ? true : false;
  },
};

// ── Korea RRN (Resident Registration Number) ─────────────────────────────

export const krRrnRecognizer: Recognizer = {
  id: "kr_rrn",
  patterns: [
    {
      name: "rrn_dashed",
      regex: /\b\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-[1-4]\d{6}\b/g,
      score: 0.5,
    },
  ],
  contextWords: [
    "resident registration", "주민등록번호", "resident number",
    "registration number",
  ],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 13) return false;
    // Region code: positions 7-8 (0-indexed 6-7), must be 0-95
    const region = digits[6]! * 10 + digits[7]!;
    if (region > 95) return false;
    // Weighted checksum
    const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += digits[i]! * weights[i]!;
    }
    const check = (11 - (sum % 11)) % 10;
    return check === digits[12] ? null : false;
  },
};

// ── Singapore FIN/NRIC ───────────────────────────────────────────────────

export const sgFinRecognizer: Recognizer = {
  id: "sg_fin",
  patterns: [
    {
      name: "sg_nric_fin",
      regex: /\b[STFGM]\d{7}[A-Z]\b/g,
      score: 0.3,
    },
  ],
  contextWords: ["fin", "nric", "singapore", "identity card", "singapore id"],
  validate(match: string): boolean | null {
    const upper = match.toUpperCase();
    const digits = upper.slice(1, 8).split("").map(Number);
    const weights = [2, 7, 6, 5, 4, 3, 2];

    let sum = 0;
    for (let i = 0; i < 7; i++) {
      sum += digits[i]! * weights[i]!;
    }

    // Offset for T/G prefix
    const prefix = upper[0]!;
    if (prefix === "T" || prefix === "G") sum += 4;
    if (prefix === "M") sum += 3;

    const remainder = sum % 11;
    const stCheckChars = "JZIHGFEDCBA";
    const fgCheckChars = "XWUTRQPNMLK";
    const mCheckChars = "KLJNPQRTUWX";

    let expectedCheck: string | undefined;
    if (prefix === "S" || prefix === "T") expectedCheck = stCheckChars[remainder];
    else if (prefix === "F" || prefix === "G") expectedCheck = fgCheckChars[remainder];
    else if (prefix === "M") expectedCheck = mCheckChars[remainder];

    return upper[8] === expectedCheck ? null : false;
  },
};
