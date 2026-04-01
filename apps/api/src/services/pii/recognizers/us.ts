/**
 * US-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/us/.
 */

import type { Recognizer } from "../types.js";
import { luhn, extractDigits, usBankRoutingCheck } from "../checksums.js";

// ── US SSN ───────────────────────────────────────────────────────────────

export const usSsnRecognizer: Recognizer = {
  id: "us_ssn",
  patterns: [
    {
      name: "ssn_dashes",
      regex: /\b(\d{3})-(\d{2})-(\d{4})\b/g,
      score: 0.5,
    },
    {
      name: "ssn_spaces",
      regex: /\b(\d{3})\s(\d{2})\s(\d{4})\b/g,
      score: 0.5,
    },
    {
      name: "ssn_contiguous",
      regex: /\b\d{9}\b/g,
      score: 0.05, // Very low without context — 9 random digits are common
    },
  ],
  contextWords: ["social", "security", "ssn", "ssns", "ssid", "previdenza sociale"],
  validate(match: string): boolean | null {
    const sanitized = match.replace(/[\s\-]/g, "");
    if (sanitized.length !== 9) return false;

    // All same digit
    if (/^(.)\1+$/.test(sanitized)) return false;

    const area = sanitized.slice(0, 3);
    const group = sanitized.slice(3, 5);
    const serial = sanitized.slice(5, 9);

    // Invalid area numbers
    if (area === "000" || area === "666" || area[0] === "9") return false;
    // Zero group or serial
    if (group === "00" || serial === "0000") return false;

    return null; // Passes structural validation, keep base score
  },
};

// ── US ITIN ──────────────────────────────────────────────────────────────

export const usItinRecognizer: Recognizer = {
  id: "us_itin",
  patterns: [
    {
      name: "itin_dashes",
      regex: /\b9\d{2}[- ](5\d|6[0-5]|7\d|8[0-8]|9[024-9])[- ]\d{4}\b/g,
      score: 0.5,
    },
    {
      name: "itin_contiguous",
      regex: /\b9\d{2}(5\d|6[0-5]|7\d|8[0-8]|9[024-9])\d{4}\b/g,
      score: 0.3,
    },
  ],
  contextWords: ["individual", "taxpayer", "itin", "tax", "payer", "taxid", "tin"],
};

// ── US Passport ──────────────────────────────────────────────────────────

export const usPassportRecognizer: Recognizer = {
  id: "us_passport",
  patterns: [
    {
      name: "us_passport",
      regex: /\b[A-Z]\d{8}\b/g,
      score: 0.3,
    },
  ],
  contextWords: ["passport", "travel document", "passaporto", "pasaporte"],
};

// ── US Driver License (simplified — state-specific patterns vary widely) ─

export const usDriverLicenseRecognizer: Recognizer = {
  id: "us_driver_license",
  patterns: [
    {
      name: "us_dl_alpha_numeric",
      regex: /\b[A-Z]{1,2}\d{5,12}\b/g,
      score: 0.1, // Very low base — too many false positives without context
    },
  ],
  contextWords: ["driver", "license", "licence", "dl", "driving", "patente"],
};

// ── US Bank Routing (ABA) ────────────────────────────────────────────────

export const usBankRoutingRecognizer: Recognizer = {
  id: "us_bank_routing",
  patterns: [
    {
      name: "aba_routing",
      regex: /\b\d{9}\b/g,
      score: 0.05, // Very low base — 9 digits are everywhere
    },
  ],
  contextWords: ["routing", "aba", "transit", "bank", "wire"],
  validate(match: string): boolean | null {
    return usBankRoutingCheck(match) ? null : false;
  },
};

// ── US NPI (National Provider Identifier) ────────────────────────────────

export const usNpiRecognizer: Recognizer = {
  id: "us_npi",
  patterns: [
    {
      name: "npi",
      regex: /\b\d{10}\b/g,
      score: 0.05,
    },
  ],
  contextWords: ["npi", "national provider", "provider identifier", "cms"],
  validate(match: string): boolean | null {
    const digits = extractDigits(match);
    if (digits.length !== 10) return false;
    // NPI uses Luhn with "80840" prefix
    const withPrefix = [8, 0, 8, 4, 0, ...digits];
    const str = withPrefix.join("");
    return luhn(str) ? null : false;
  },
};
