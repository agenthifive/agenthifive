/**
 * Checksum validators for PII detection.
 * All pure functions, zero dependencies. Ported from Microsoft Presidio (MIT).
 */

/** Extract digits from a string, stripping separators. */
export function extractDigits(s: string): number[] {
  return s.replace(/[\s\-.]/g, "").split("").map(Number);
}

// ── Luhn (credit cards, US NPI, IT VAT) ──────────────────────────────────

export function luhn(input: string): boolean {
  const digits = extractDigits(input);
  if (digits.length === 0) return false;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i]!;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ── Verhoeff (India Aadhaar) ─────────────────────────────────────────────

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(input: string): boolean {
  const digits = extractDigits(input);
  if (digits.length === 0) return false;

  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c]![VERHOEFF_P[i % 8]![reversed[i]!]!]!;
  }
  return c === 0;
}

// ── IBAN mod-97 ──────────────────────────────────────────────────────────

export function ibanMod97(iban: string): boolean {
  const cleaned = iban.replace(/[\s\-]/g, "").toUpperCase();
  if (cleaned.length < 5) return false;

  // Move first 4 chars to end
  const rearranged = cleaned.slice(4) + cleaned.slice(0, 4);

  // Convert letters to numbers (A=10, B=11, ..., Z=35)
  let numeric = "";
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) {
      numeric += (code - 55).toString();
    } else {
      numeric += ch;
    }
  }

  // mod 97 on the (very large) number — process in chunks to avoid BigInt
  let remainder = 0;
  for (let i = 0; i < numeric.length; i++) {
    remainder = (remainder * 10 + parseInt(numeric[i]!, 10)) % 97;
  }
  return remainder === 1;
}

// ── Weighted mod-N (generic, used by many country recognizers) ───────────

export function mod11(digits: number[], weights: number[]): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length && i < weights.length; i++) {
    sum += digits[i]! * weights[i]!;
  }
  return sum % 11 === 0;
}

export function mod89(input: string, weights: number[]): boolean {
  const digits = extractDigits(input);
  if (digits.length !== weights.length) return false;
  // Adjust first digit (ABN rule)
  const adjusted = [...digits];
  adjusted[0] = adjusted[0]! === 0 ? 9 : adjusted[0]! - 1;
  let sum = 0;
  for (let i = 0; i < adjusted.length; i++) {
    sum += adjusted[i]! * weights[i]!;
  }
  return sum % 89 === 0;
}

export function weightedMod10(digits: number[], weights: number[]): boolean {
  if (digits.length !== weights.length + 1) return false;
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += digits[i]! * weights[i]!;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits[digits.length - 1];
}

// ── Italian fiscal code control character ────────────────────────────────

const IT_ODD_MAP: Record<string, number> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14,
  U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

const IT_EVEN_MAP: Record<string, number> = {
  "0": 0, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
  A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
  K: 10, L: 11, M: 12, N: 13, O: 14, P: 15, Q: 16, R: 17, S: 18, T: 19,
  U: 20, V: 21, W: 22, X: 23, Y: 24, Z: 25,
};

export function italianFiscalCodeCheck(code: string): boolean {
  const upper = code.toUpperCase();
  if (upper.length !== 16) return false;

  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const ch = upper[i]!;
    // Positions are 1-indexed: odd positions use odd map, even use even map
    const isOddPosition = (i + 1) % 2 === 1;
    const val = isOddPosition ? IT_ODD_MAP[ch] : IT_EVEN_MAP[ch];
    if (val === undefined) return false;
    sum += val;
  }

  const controlChar = String.fromCharCode(65 + (sum % 26)); // A=65
  return upper[15] === controlChar;
}

// ── Spanish NIF/NIE letter ───────────────────────────────────────────────

const SPANISH_NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

export function spanishNifCheck(input: string): boolean {
  const upper = input.toUpperCase().replace(/[\s\-]/g, "");
  if (upper.length < 2) return false;

  let numericPart: string;
  const firstChar = upper[0]!;

  // NIE: X→0, Y→1, Z→2 prefix
  if (firstChar === "X") numericPart = "0" + upper.slice(1, -1);
  else if (firstChar === "Y") numericPart = "1" + upper.slice(1, -1);
  else if (firstChar === "Z") numericPart = "2" + upper.slice(1, -1);
  else numericPart = upper.slice(0, -1);

  const num = parseInt(numericPart, 10);
  if (isNaN(num)) return false;

  const expectedLetter = SPANISH_NIF_LETTERS[num % 23];
  return upper[upper.length - 1] === expectedLetter;
}

// ── Finnish PIC control character ────────────────────────────────────────

const FINNISH_CONTROL = "0123456789ABCDEFHJKLMNPRSTUVWXY";

export function finnishPicCheck(input: string): boolean {
  const cleaned = input.replace(/\s/g, "");
  // Format: DDMMYY{separator}{individual}{control}
  // The separator indicates century but we don't validate that here
  const match = cleaned.match(/^(\d{6})[+\-ABCDEFYXWVU](\d{3})([0-9A-Z])$/);
  if (!match) return false;

  const datePart = match[1]!;
  const individualPart = match[2]!;
  const controlChar = match[3]!;

  const num = parseInt(datePart + individualPart, 10);
  if (isNaN(num)) return false;

  return FINNISH_CONTROL[num % 31] === controlChar;
}

// ── US bank routing checksum ─────────────────────────────────────────────

export function usBankRoutingCheck(input: string): boolean {
  const digits = extractDigits(input);
  if (digits.length !== 9) return false;

  // Weighted: 3*d1 + 7*d2 + 1*d3 + 3*d4 + 7*d5 + 1*d6 + 3*d7 + 7*d8 + 1*d9
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += digits[i]! * weights[i]!;
  }
  return sum % 10 === 0;
}
