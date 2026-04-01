/**
 * Context word enhancement for PII detection.
 *
 * Boosts the confidence score of a PII match when relevant context words
 * appear nearby in the text (e.g. "ssn" near a 9-digit number).
 *
 * Ported from Presidio's LemmaContextAwareEnhancer, simplified for JS
 * (no NLP/lemmatization — uses raw substring matching).
 */

const CONTEXT_BOOST = 0.35;
const MIN_SCORE_WITH_CONTEXT = 0.4;
const MAX_SCORE = 1.0;
const DEFAULT_WINDOW_SIZE = 5;

/**
 * Calculate the context word boost for a match at `matchStart`.
 *
 * Extracts up to `windowSize` tokens before the match, checks if any
 * context word appears as a substring of any token. Returns the boosted
 * score (original + 0.35 if context found, capped at 1.0).
 */
export function enhanceScoreWithContext(
  text: string,
  matchStart: number,
  baseScore: number,
  contextWords: string[],
  windowSize = DEFAULT_WINDOW_SIZE,
): number {
  if (contextWords.length === 0) return baseScore;

  // Extract text before the match and tokenize
  const prefix = text.slice(0, matchStart).toLowerCase();
  const tokens = prefix.split(/[\s,;:!?.()[\]{}"']+/).filter(Boolean).slice(-windowSize);

  // Check if any token contains any context word as substring
  for (const token of tokens) {
    for (const cw of contextWords) {
      if (token.includes(cw)) {
        return Math.min(Math.max(baseScore + CONTEXT_BOOST, MIN_SCORE_WITH_CONTEXT), MAX_SCORE);
      }
    }
  }

  return baseScore;
}
