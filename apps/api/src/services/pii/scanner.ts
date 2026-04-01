/**
 * PII Scanner — core detection engine.
 *
 * Runs enabled recognizers against text, validates matches, applies context
 * word scoring, merges overlapping entities, and builds a redacted string.
 */

import type { Recognizer, PiiEntity, PiiRedactor } from "./types.js";
import { enhanceScoreWithContext } from "./context.js";

const DEFAULT_THRESHOLD = 0.4;
const MAX_SCORE = 1.0;
const MIN_SCORE = 0.0;

/**
 * Regex matching zero-width / formatting HTML tags that providers (Google)
 * inject into long strings for display rendering. These split PII tokens
 * into fragments the scanner can't recognise.
 */
const FORMATTING_TAG_RE = /<wbr\s*\/?>|&shy;|&zwj;|&zwnj;|&#8203;|&#x200[bBcCdD];|\u200B|\u200C|\u200D|\u00AD/g;

/**
 * Strip formatting tags from text and build a position map from clean
 * offsets back to original offsets, so detected entity spans can be
 * applied to the original string.
 *
 * Returns null if the text contains no formatting tags (fast path).
 */
function stripFormattingTags(text: string): {
  clean: string;
  /** Map clean offset → original offset (length = clean.length + 1 for end positions) */
  toOriginal: number[];
} | null {
  if (!FORMATTING_TAG_RE.test(text)) return null;
  // Reset lastIndex after test()
  FORMATTING_TAG_RE.lastIndex = 0;

  const toOriginal: number[] = [];
  const parts: string[] = [];
  let lastEnd = 0;
  let cleanOffset = 0;
  let match: RegExpExecArray | null;

  while ((match = FORMATTING_TAG_RE.exec(text)) !== null) {
    const chunk = text.slice(lastEnd, match.index);
    parts.push(chunk);
    for (let i = 0; i < chunk.length; i++) {
      toOriginal[cleanOffset++] = lastEnd + i;
    }
    lastEnd = match.index + match[0].length;
  }

  const tail = text.slice(lastEnd);
  parts.push(tail);
  for (let i = 0; i < tail.length; i++) {
    toOriginal[cleanOffset++] = lastEnd + i;
  }
  // One extra entry for end-of-string positions
  toOriginal[cleanOffset] = text.length;

  return { clean: parts.join(""), toOriginal };
}

/**
 * Fast-path regex: detects transitions where PII values are concatenated
 * without whitespace separators (common in Notion title/property fields).
 *
 * Matches:
 * - digit → uppercase word (2+ uppercase, or uppercase + 2+ lowercase)
 * - digit → opening paren
 * - closing paren → letter
 * - letter → plus sign followed by digit (international phone prefix)
 *
 * Does NOT fire on:
 * - digit → single uppercase (hex like 0x742d35Cc...)
 * - lowercase → uppercase (camelCase)
 */
const BOUNDARY_FAST_RE = /\d(?=[A-Z]{2}|[A-Z][a-z]{2})|\d\(|\)[a-zA-Z]|[a-zA-Z]\+\d/;

/**
 * Insert synthetic spaces at digit→word and similar transitions so that
 * \b word-boundary anchors in PII regexes fire correctly on concatenated text.
 *
 * Returns null if no concatenation boundaries are detected (fast path).
 *
 * The `toSource` map converts normalized offsets back to source offsets,
 * allowing detected entity spans to be applied to the pre-normalization string.
 */
function insertBoundarySpaces(text: string): {
  normalized: string;
  /** Map normalized offset → source offset (length = normalized.length + 1) */
  toSource: number[];
} | null {
  if (!BOUNDARY_FAST_RE.test(text)) return null;

  const toSource: number[] = [];
  const parts: string[] = [];
  let normOffset = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    // Emit the current character
    parts.push(ch);
    toSource[normOffset++] = i;

    if (!next) continue;

    let insertSpace = false;

    // digit → uppercase word start (not single hex char)
    if (ch >= "0" && ch <= "9" && next >= "A" && next <= "Z") {
      const after = text[i + 2];
      // 2+ uppercase letters (abbreviation like SSN, ITIN)
      if (after && after >= "A" && after <= "Z") {
        insertSpace = true;
      }
      // uppercase + 2+ lowercase (word like Phone, Credit)
      else if (after && after >= "a" && after <= "z") {
        const after2 = text[i + 3];
        if (after2 && after2 >= "a" && after2 <= "z") {
          insertSpace = true;
        }
      }
    }
    // digit → opening paren
    else if (ch >= "0" && ch <= "9" && next === "(") {
      insertSpace = true;
    }
    // closing paren → letter
    else if (ch === ")" && ((next >= "a" && next <= "z") || (next >= "A" && next <= "Z"))) {
      insertSpace = true;
    }
    // letter → plus sign followed by digit (phone prefix like +39)
    else if (
      ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) &&
      next === "+" &&
      text[i + 2] &&
      text[i + 2]! >= "0" && text[i + 2]! <= "9"
    ) {
      insertSpace = true;
    }

    if (insertSpace) {
      parts.push(" ");
      // The synthetic space maps to the same source position as the next char
      toSource[normOffset++] = i + 1;
    }
  }

  // End-of-string sentinel
  toSource[normOffset] = text.length;

  return { normalized: parts.join(""), toSource };
}

/**
 * Scan text with a set of recognizers and return all detected PII entities
 * above the score threshold.
 */
export function scanText(
  text: string,
  recognizers: Recognizer[],
  threshold = DEFAULT_THRESHOLD,
): PiiEntity[] {
  const rawEntities: PiiEntity[] = [];

  for (const rec of recognizers) {
    // Custom detector (e.g. phone numbers via libphonenumber-js)
    if (rec.detect) {
      const detected = rec.detect(text);
      for (const entity of detected) {
        const boosted = enhanceScoreWithContext(
          text, entity.start, entity.score, rec.contextWords,
        );
        if (boosted >= threshold) {
          rawEntities.push({ ...entity, score: boosted });
        }
      }
      continue;
    }

    // Regex-based detection
    for (const pattern of rec.patterns) {
      // Clone the regex to avoid lastIndex issues with global flag
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        const matchText = match[0];
        const start = match.index;
        const end = start + matchText.length;

        // Validate
        let score = pattern.score;
        if (rec.validate) {
          const result = rec.validate(matchText);
          if (result === false) {
            score = MIN_SCORE; // Discard
          } else if (result === true) {
            score = MAX_SCORE; // Boost to maximum
          }
          // null = keep base score
        }

        if (score <= MIN_SCORE) continue;

        // Context word enhancement
        score = enhanceScoreWithContext(text, start, score, rec.contextWords);

        if (score >= threshold) {
          rawEntities.push({ type: rec.id, start, end, text: matchText, score });
        }
      }
    }
  }

  return mergeOverlapping(rawEntities);
}

/**
 * Merge overlapping entities. When two entities overlap:
 * - The longer one wins
 * - At equal length, the higher score wins
 */
function mergeOverlapping(entities: PiiEntity[]): PiiEntity[] {
  if (entities.length <= 1) return entities;

  // Sort by start position, then by length descending, then by score descending
  entities.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.score - a.score;
  });

  const merged: PiiEntity[] = [entities[0]!];

  for (let i = 1; i < entities.length; i++) {
    const current = entities[i]!;
    const last = merged[merged.length - 1]!;

    // If current overlaps with last, skip it (last is already the better one)
    if (current.start < last.end) {
      // Keep the one with larger span, or higher score if same span
      if ((current.end - current.start) > (last.end - last.start)) {
        merged[merged.length - 1] = current;
      } else if (
        (current.end - current.start) === (last.end - last.start) &&
        current.score > last.score
      ) {
        merged[merged.length - 1] = current;
      }
      continue;
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Build a redacted string by replacing detected entity spans with the replacement text.
 */
function redactText(
  text: string,
  entities: PiiEntity[],
  replacement: string,
): string {
  if (entities.length === 0) return text;

  // Entities are already sorted by start position from mergeOverlapping
  const parts: string[] = [];
  let cursor = 0;

  for (const entity of entities) {
    if (entity.start > cursor) {
      parts.push(text.slice(cursor, entity.start));
    }
    parts.push(replacement);
    cursor = entity.end;
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.join("");
}

/**
 * Create a PiiRedactor from a set of recognizers and options.
 */
export function createRedactor(
  recognizers: Recognizer[],
  replacement: string,
  threshold = DEFAULT_THRESHOLD,
): PiiRedactor {
  return {
    redact(text: string): string {
      // Pipeline: original → strip formatting tags → insert boundary spaces → scan → map back → redact original
      //
      // Each optional step produces a position map; we compose them to translate
      // detected entity spans all the way back to the original string.

      // Step 1: Strip formatting tags (Google <wbr />, &shy;, etc.)
      const stripped = stripFormattingTags(text);
      const base = stripped ? stripped.clean : text;

      // Step 2: Insert boundary spaces for concatenated text (Notion titles)
      const spaced = insertBoundarySpaces(base);
      const scannable = spaced ? spaced.normalized : base;

      // Fast path: nothing transformed, scan raw text directly
      if (!stripped && !spaced) {
        const entities = scanText(text, recognizers, threshold);
        return redactText(text, entities, replacement);
      }

      // Scan the fully normalized text
      const entities = scanText(scannable, recognizers, threshold);
      if (entities.length === 0) return text;

      // Map entity positions back through the chain:
      // scannable offset → base offset (via spaced.toSource)
      // base offset → original offset (via stripped.toOriginal)
      const mappedEntities = entities.map((e) => {
        let start = e.start;
        let end = e.end;

        // Undo boundary space insertion
        if (spaced) {
          start = spaced.toSource[start]!;
          end = spaced.toSource[end]!;
        }

        // Undo formatting tag stripping
        if (stripped) {
          start = stripped.toOriginal[start]!;
          end = stripped.toOriginal[end]!;
        }

        return { ...e, start, end };
      });

      return redactText(text, mappedEntities, replacement);
    },
  };
}
