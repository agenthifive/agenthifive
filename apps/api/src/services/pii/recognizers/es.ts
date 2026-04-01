/**
 * Spain-specific PII recognizers.
 * Ported from Presidio's predefined_recognizers/country_specific/spain/.
 */

import type { Recognizer } from "../types.js";
import { spanishNifCheck } from "../checksums.js";

// ── Spain NIF (Número de Identificación Fiscal) ─────────────────────────

export const esNifRecognizer: Recognizer = {
  id: "es_nif",
  patterns: [
    {
      name: "nif",
      regex: /\b\d{7,8}[A-Z]\b/g,
      score: 0.5,
    },
  ],
  contextWords: [
    "documento nacional de identidad", "dni", "nif",
    "identificación", "identificacion", "fiscal",
  ],
  validate(match: string): boolean | null {
    return spanishNifCheck(match) ? true : false;
  },
};

// ── Spain NIE (Número de Identidad de Extranjero) ────────────────────────

export const esNieRecognizer: Recognizer = {
  id: "es_nie",
  patterns: [
    {
      name: "nie",
      regex: /\b[XYZ]\d{7}[A-Z]\b/g,
      score: 0.5,
    },
  ],
  contextWords: ["nie", "extranjero", "número de identidad", "foreigner id"],
  validate(match: string): boolean | null {
    return spanishNifCheck(match) ? true : false;
  },
};
