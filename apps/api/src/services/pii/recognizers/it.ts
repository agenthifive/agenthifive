/**
 * Italy-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/italy/.
 */

import type { Recognizer } from "../types.js";
import { italianFiscalCodeCheck, luhn, extractDigits } from "../checksums.js";

// ── Italian Fiscal Code (Codice Fiscale) ─────────────────────────────────

export const itFiscalCodeRecognizer: Recognizer = {
  id: "it_fiscal_code",
  patterns: [
    {
      name: "codice_fiscale",
      regex: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi,
      score: 0.5,
    },
  ],
  contextWords: [
    "codice fiscale", "cf", "fiscal", "fiscale", "tax code",
    "codice", "contribuente",
  ],
  validate(match: string): boolean | null {
    return italianFiscalCodeCheck(match) ? true : false;
  },
};

// ── Italian VAT (Partita IVA) ────────────────────────────────────────────

export const itVatRecognizer: Recognizer = {
  id: "it_vat",
  patterns: [
    {
      name: "partita_iva_prefix",
      regex: /\bIT\d{11}\b/gi,
      score: 0.5,
    },
    {
      name: "partita_iva_bare",
      regex: /\b\d{11}\b/g,
      score: 0.05, // Very low without prefix
    },
  ],
  contextWords: [
    "partita iva", "p.iva", "p. iva", "vat", "iva",
    "tax identification", "codice iva",
  ],
  validate(match: string): boolean | null {
    // Strip "IT" prefix if present
    const digits = match.replace(/^IT/i, "");
    if (digits.length !== 11) return false;
    if (!/^\d{11}$/.test(digits)) return false;
    return luhn(digits) ? null : false;
  },
};

// ── Italian Passport ─────────────────────────────────────────────────────

export const itPassportRecognizer: Recognizer = {
  id: "it_passport",
  patterns: [
    {
      name: "it_passport",
      regex: /\b[A-Z]{2}\d{7}\b/g,
      score: 0.3,
    },
  ],
  contextWords: ["passaporto", "passport", "travel document", "documento di viaggio"],
};

// ── Italian Identity Card (Carta d'Identità Elettronica) ─────────────────

export const itIdentityCardRecognizer: Recognizer = {
  id: "it_identity_card",
  patterns: [
    {
      name: "cie_new",
      // New format: CA00000AA (2 letters + 5 digits + 2 letters)
      regex: /\b[A-Z]{2}\d{5}[A-Z]{2}\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "carta d'identità", "carta identità", "cie", "identity card",
    "documento d'identità", "carta di identità",
  ],
};

// ── Italian Driver License ───────────────────────────────────────────────

export const itDriverLicenseRecognizer: Recognizer = {
  id: "it_driver_license",
  patterns: [
    {
      name: "it_dl",
      regex: /\b[A-Z]{2}\d{7}[A-Z]\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "patente", "patente di guida", "driver license", "driving licence",
    "licenza di guida",
  ],
};
