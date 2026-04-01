/**
 * PII Detection Engine — Type Definitions
 *
 * Presidio-inspired architecture: each PII type is a Recognizer with
 * regex patterns, context words, and optional validation (checksums).
 */

/** A single regex pattern with a base confidence score. */
export interface Pattern {
  name: string;
  regex: RegExp;
  score: number; // 0.0–1.0
}

/** A detected PII entity with its position and confidence. */
export interface PiiEntity {
  type: string; // recognizer ID, e.g. "credit_card", "us_ssn"
  start: number;
  end: number;
  text: string;
  score: number; // final confidence after validation + context
}

/**
 * A PII recognizer — detects one class of PII using regex + validation + context.
 *
 * For most recognizers, `patterns` contains one or more regex patterns.
 * The `detect` override is for non-regex detectors (e.g. libphonenumber-js).
 */
export interface Recognizer {
  id: string;
  patterns: Pattern[];
  contextWords: string[];
  /** Override regex-based detection with a custom detector (e.g. phone numbers). */
  detect?: (text: string) => PiiEntity[];
  /** Post-match validation. Return true to boost to 1.0, false to discard, null for no change. */
  validate?: (match: string) => boolean | null;
}

/** Compiled redactor — the public interface consumed by the policy engine. */
export interface PiiRedactor {
  redact(text: string): string;
}
