/**
 * Phone number recognizer using libphonenumber-js.
 * Replaces the naive US-only regex with Google's international phone parser.
 */

import { findPhoneNumbersInText } from "libphonenumber-js";
import type { Recognizer, PiiEntity } from "../types.js";

export const phoneRecognizer: Recognizer = {
  id: "phone",
  patterns: [], // Not regex-based — uses detect() override
  contextWords: [
    "phone", "telephone", "cell", "cellphone", "mobile", "call", "fax",
    "tel", "contact", "number", "dial",
    "telefono", "cellulare", "chiamare", "numero",
    "téléphone", "portable", "appeler",
    "telefon", "anrufen", "handy",
  ],
  detect(text: string): PiiEntity[] {
    const results: PiiEntity[] = [];

    try {
      const found = findPhoneNumbersInText(text);
      for (const match of found) {
        results.push({
          type: "phone",
          start: match.startsAt,
          end: match.endsAt,
          text: text.slice(match.startsAt, match.endsAt),
          score: 0.4,
        });
      }
    } catch {
      // Malformed input — skip
    }

    return results;
  },
};
