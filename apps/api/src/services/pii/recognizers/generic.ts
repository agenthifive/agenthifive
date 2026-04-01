/**
 * Generic (cross-country) PII recognizers.
 * Ported from Presidio's predefined_recognizers/generic/.
 */

import type { Recognizer } from "../types.js";
import { luhn, ibanMod97 } from "../checksums.js";

// ── Email ────────────────────────────────────────────────────────────────

export const emailRecognizer: Recognizer = {
  id: "email",
  patterns: [
    {
      name: "email",
      regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
      score: 0.5,
    },
  ],
  contextWords: ["email", "e-mail", "mail", "address", "contact", "correo", "posta"],
};

// ── Credit Card ──────────────────────────────────────────────────────────

export const creditCardRecognizer: Recognizer = {
  id: "credit_card",
  patterns: [
    {
      name: "credit_card_spaced",
      // 4 groups of 4 digits (Visa/MC) or 4-6-5 (Amex) with spaces/dashes
      regex: /\b(?:\d{4}[\s\-]){3}\d{4}\b/g,
      score: 0.5,
    },
    {
      name: "credit_card_amex",
      regex: /\b3[47]\d{2}[\s\-]?\d{6}[\s\-]?\d{5}\b/g,
      score: 0.5,
    },
    {
      name: "credit_card_contiguous",
      regex: /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "credit", "card", "visa", "mastercard", "mc", "amex", "american express",
    "discover", "jcb", "diners", "maestro", "cc", "carta di credito",
  ],
  validate(match: string): boolean | null {
    const digits = match.replace(/[\s\-]/g, "");
    if (digits.length < 13 || digits.length > 19) return false;
    if (/^(.)\1+$/.test(digits)) return false; // all same digit
    return luhn(digits) ? true : false;
  },
};

// ── IBAN ─────────────────────────────────────────────────────────────────

// Country code → expected total IBAN length
const IBAN_LENGTHS: Record<string, number> = {
  AL: 28, AD: 24, AT: 20, AZ: 28, BH: 22, BY: 28, BE: 16, BA: 20,
  BR: 29, BG: 22, CR: 22, HR: 21, CY: 28, CZ: 24, DK: 18, DO: 28,
  TL: 23, EG: 29, SV: 28, EE: 20, FO: 18, FI: 18, FR: 27, GE: 22,
  DE: 22, GI: 23, GR: 27, GL: 18, GT: 28, HU: 28, IS: 26, IQ: 23,
  IE: 22, IL: 23, IT: 27, JO: 30, KZ: 20, XK: 20, KW: 30, LV: 21,
  LB: 28, LY: 25, LI: 21, LT: 20, LU: 20, MK: 19, MT: 31, MR: 27,
  MU: 30, MC: 27, MD: 24, ME: 22, NL: 18, NO: 15, PK: 24, PS: 29,
  PL: 28, PT: 25, QA: 29, RO: 24, LC: 32, SM: 27, ST: 25, SA: 24,
  RS: 22, SC: 31, SK: 24, SI: 19, ES: 24, SD: 18, SE: 24, CH: 21,
  TN: 24, TR: 26, UA: 29, AE: 23, GB: 22, VA: 22, VG: 24,
};

export const ibanRecognizer: Recognizer = {
  id: "iban",
  patterns: [
    {
      name: "iban_spaced",
      regex: /\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}(?:[\s]?[\dA-Z]{4}){2,7}(?:[\s]?[\dA-Z]{1,4})?\b/g,
      score: 0.5,
    },
    {
      name: "iban_compact",
      regex: /\b[A-Z]{2}\d{2}[\dA-Z]{8,30}\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "iban", "international bank", "account number", "bank account",
    "conto corrente", "kontonummer", "cuenta bancaria",
  ],
  validate(match: string): boolean | null {
    const cleaned = match.replace(/\s/g, "").toUpperCase();
    const country = cleaned.slice(0, 2);
    const expectedLen = IBAN_LENGTHS[country];
    if (expectedLen && cleaned.length !== expectedLen) return false;
    return ibanMod97(cleaned) ? true : false;
  },
};

// ── IP Address ───────────────────────────────────────────────────────────

export const ipAddressRecognizer: Recognizer = {
  id: "ip_address",
  patterns: [
    {
      name: "ipv4",
      regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
      score: 0.5,
    },
    {
      name: "ipv6",
      regex: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g,
      score: 0.5,
    },
  ],
  contextWords: ["ip", "address", "ipv4", "ipv6", "host", "server", "indirizzo"],
};

// ── URL ──────────────────────────────────────────────────────────────────

export const urlRecognizer: Recognizer = {
  id: "url",
  patterns: [
    {
      name: "url_with_scheme",
      regex: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,
      score: 0.5,
    },
  ],
  contextWords: ["url", "website", "link", "http", "https", "sito", "enlace"],
};

// ── Crypto Wallet ────────────────────────────────────────────────────────

export const cryptoWalletRecognizer: Recognizer = {
  id: "crypto_wallet",
  patterns: [
    {
      name: "bitcoin_p2pkh",
      regex: /\b1[a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
      score: 0.3,
    },
    {
      name: "bitcoin_p2sh",
      regex: /\b3[a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
      score: 0.3,
    },
    {
      name: "bitcoin_bech32",
      regex: /\bbc1[a-zA-HJ-NP-Z0-9]{25,89}\b/g,
      score: 0.5,
    },
    {
      name: "ethereum",
      regex: /\b0x[0-9a-fA-F]{40}\b/g,
      score: 0.5,
    },
  ],
  contextWords: [
    "bitcoin", "btc", "wallet", "ethereum", "eth", "crypto",
    "blockchain", "address", "portafoglio",
  ],
};

// ── Date of Birth ────────────────────────────────────────────────────────

export const dateOfBirthRecognizer: Recognizer = {
  id: "date_of_birth",
  patterns: [
    {
      name: "dob_slash_mdy",
      regex: /\b(?:0[1-9]|1[0-2])\/(?:0[1-9]|[12]\d|3[01])\/(?:19|20)\d{2}\b/g,
      score: 0.3,
    },
    {
      name: "dob_slash_dmy",
      regex: /\b(?:0[1-9]|[12]\d|3[01])\/(?:0[1-9]|1[0-2])\/(?:19|20)\d{2}\b/g,
      score: 0.3,
    },
    {
      name: "dob_dot_dmy",
      regex: /\b(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])\.(?:19|20)\d{2}\b/g,
      score: 0.3,
    },
    {
      name: "dob_iso",
      regex: /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g,
      score: 0.3,
    },
  ],
  contextWords: [
    "born", "birth", "birthday", "dob", "date of birth",
    "nascita", "data di nascita", "geburtsdatum", "fecha de nacimiento",
  ],
  validate(match: string): boolean | null {
    // Basic date validity check
    const parts = match.split(/[\/.\-]/);
    if (parts.length !== 3) return false;
    const nums = parts.map(Number);
    // Accept if all parts are reasonable numbers (not NaN)
    return nums.every((n) => !isNaN(n) && n > 0) ? null : false;
  },
};

// ── MAC Address ──────────────────────────────────────────────────────────

export const macAddressRecognizer: Recognizer = {
  id: "mac_address",
  patterns: [
    {
      name: "mac_colon",
      regex: /\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b/g,
      score: 0.3,
    },
    {
      name: "mac_dash",
      regex: /\b[0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5}\b/g,
      score: 0.3,
    },
  ],
  contextWords: ["mac", "address", "hardware", "ethernet", "nic", "indirizzo mac"],
};

// ── Secret Codes (PIN, PUK, CVV, passwords) ─────────────────────────

/**
 * Detects short numeric codes (3-8 digits) near context keywords like
 * PIN, PUK, CVV, passcode, security code, etc. People commonly store
 * these in contact notes, biographies, and custom fields.
 *
 * Also catches "password: ..." patterns (any word/phrase after the label).
 */
export const secretCodeRecognizer: Recognizer = {
  id: "secret_code",
  patterns: [
    {
      name: "labeled_numeric_code",
      // Matches: "PIN: 1234", "PUK 12345678", "CVV:123", "CVC 456", "code: 9876"
      // Also handles "PIN is 5678", "PIN was 1234", "PIN = 5678"
      // "code" alone requires a delimiter (: = -) to avoid false positives
      regex: /\b(?:pin[12]?|puk[12]?|cvv2?|cvc2?|security\s*code|unlock\s*code|alarm\s*code|safe\s*code|access\s*code|otp|passcode|codice|codigo)\s*(?:[:=\-–—]|is|was|est|è)?\s*(\d{3,8})\b/gi,
      score: 0.9,
    },
    {
      name: "labeled_password",
      // Matches: "password: mySecret123", "pwd: abc", "pass: hunter2", "mot de passe: ..."
      regex: /\b(?:password|passwd|pwd|pass|passphrase|mot\s+de\s+passe|contraseña|passwort|parola|wachtwoord)\s*[:=\-–—]\s*(\S+(?:\s+\S+){0,3})/gi,
      score: 0.9,
    },
    {
      name: "labeled_secret_key",
      // Matches: "API key: sk-...", "secret: ...", "token: ...", "chiave: ..."
      regex: /\b(?:api\s*key|secret\s*key|secret|token|chiave|clave)\s*[:=\-–—]\s*(\S+)/gi,
      score: 0.7,
    },
    {
      name: "sim_puk_long",
      // PUK codes are always 8 digits — catch standalone 8-digit numbers near SIM context
      regex: /\b(\d{8})\b/g,
      score: 0.2, // low base — needs context words to fire
    },
  ],
  contextWords: [
    "pin", "puk", "cvv", "cvc", "security code", "unlock", "passcode",
    "password", "pwd", "secret", "sim", "card", "bank", "debit", "credit",
    "atm", "voicemail", "alarm", "safe", "lock", "code", "otp",
    "codice", "codigo", "parola", "contraseña", "passwort", "wachtwoord",
  ],
};
