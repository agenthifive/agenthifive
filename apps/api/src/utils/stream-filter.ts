/**
 * Real-time stream filter for vault streaming responses.
 *
 * Applies response rules (PII redaction, field filtering) to streaming
 * data without buffering the entire response. Handles multiple content types:
 *
 * - SSE (text/event-stream): buffers until \n\n delimiter, parses each
 *   "data: {...}" as JSON, applies filterResponse(), re-serializes.
 *   Non-data lines (event:, id:, retry:, comments) pass through unchanged.
 *
 * - NDJSON (application/x-ndjson, application/jsonl): buffers until \n,
 *   parses each line as JSON, applies filterResponse(), re-serializes.
 *
 * - Text (text/*): applies PII redaction regex directly to chunks.
 *
 * - Binary/other: passes through unmodified.
 *
 * The filter is stateful — it maintains an internal buffer for incomplete
 * events that span multiple TCP chunks. Call transform() for each chunk,
 * then flush() at end-of-stream to emit any remaining buffered data.
 */

import { filterResponse, type CompiledPolicyRules } from "../services/policy-engine";

type CompiledResponseRule = CompiledPolicyRules["response"][number];

/**
 * Apply filtered changes to the original JSON string without re-serializing.
 *
 * When filterResponse() modifies an object (e.g., PII redaction replaces string
 * values), we need to emit the changes without re-formatting the entire JSON.
 * Re-serializing with JSON.stringify() strips the provider's whitespace style,
 * which breaks some SDK incremental parsers.
 *
 * Strategy: collect all string value changes between original and filtered objects,
 * then perform targeted string replacements on the original JSON. If the changes
 * are too complex (field additions/removals, structural changes), fall back to
 * JSON.stringify() as a last resort.
 */
function applyJsonChanges(originalJson: string, original: unknown, filtered: unknown): string {
  // Fast path: no changes
  const filteredJson = JSON.stringify(filtered);
  if (JSON.stringify(original) === filteredJson) return originalJson;

  // Collect string replacements by walking both trees
  const replacements: Array<[string, string]> = [];
  collectStringChanges(original, filtered, replacements);

  if (replacements.length === 0) {
    // Non-string changes (field removal, structural) — must re-serialize
    return filteredJson;
  }

  // Apply replacements to the original JSON string
  let result = originalJson;
  for (const [oldVal, newVal] of replacements) {
    // Escape for JSON string context: the values appear inside "..." in the JSON
    const oldEscaped = JSON.stringify(oldVal).slice(1, -1); // strip surrounding quotes
    const newEscaped = JSON.stringify(newVal).slice(1, -1);
    result = result.replace(oldEscaped, newEscaped);
  }

  // Sanity check: the result must be valid JSON
  try {
    JSON.parse(result);
    return result;
  } catch {
    // Replacement corrupted the JSON — fall back to re-serialization
    return filteredJson;
  }
}

function collectStringChanges(
  original: unknown,
  filtered: unknown,
  out: Array<[string, string]>,
): void {
  if (typeof original === "string" && typeof filtered === "string") {
    if (original !== filtered) {
      out.push([original, filtered]);
    }
    return;
  }
  if (Array.isArray(original) && Array.isArray(filtered)) {
    for (let i = 0; i < Math.min(original.length, filtered.length); i++) {
      collectStringChanges(original[i], filtered[i], out);
    }
    return;
  }
  if (typeof original === "object" && original !== null &&
      typeof filtered === "object" && filtered !== null) {
    for (const key of Object.keys(original as Record<string, unknown>)) {
      if (key in (filtered as Record<string, unknown>)) {
        collectStringChanges(
          (original as Record<string, unknown>)[key],
          (filtered as Record<string, unknown>)[key],
          out,
        );
      }
    }
  }
}

export interface StreamFilter {
  /** Process a chunk of streaming data. Returns filtered output (may be empty string if buffering). */
  transform(chunk: string): string;
  /** Flush any remaining buffered data at end-of-stream. Returns null if nothing buffered. */
  flush(): string | null;
}

/**
 * Create a stream filter appropriate for the given content type.
 */
export function createStreamFilter(
  contentType: string,
  responseRules: CompiledResponseRule[],
  method: string,
  urlPath: string,
  queryString = "",
): StreamFilter {
  const ct = contentType.toLowerCase();

  if (ct.includes("text/event-stream")) {
    return new SseStreamFilter(responseRules, method, urlPath, queryString);
  }

  if (ct.includes("application/x-ndjson") || ct.includes("application/jsonl")) {
    return new NdjsonStreamFilter(responseRules, method, urlPath, queryString);
  }

  if (ct.includes("text/")) {
    return new TextStreamFilter(responseRules, method, urlPath, queryString);
  }

  // Binary/other — passthrough
  return { transform: (chunk) => chunk, flush: () => null };
}

/**
 * SSE stream filter.
 * Buffers until \n\n (event boundary), then processes each event.
 */
class SseStreamFilter implements StreamFilter {
  private buffer = "";

  constructor(
    private rules: CompiledResponseRule[],
    private method: string,
    private urlPath: string,
    private queryString: string,
  ) {}

  transform(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    // Process all complete events (delimited by \n\n)
    let boundary: number;
    while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
      const event = this.buffer.slice(0, boundary + 2); // include the \n\n
      this.buffer = this.buffer.slice(boundary + 2);
      output += this.processEvent(event);
    }

    return output;
  }

  flush(): string | null {
    if (!this.buffer) return null;
    // Process any remaining partial event
    const remaining = this.buffer;
    this.buffer = "";
    return this.processEvent(remaining);
  }

  private processEvent(event: string): string {
    // Split into lines and process each
    const lines = event.split("\n");
    const outputLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonStr = line.slice(6); // remove "data: " prefix
        // SSE "[DONE]" sentinel (used by OpenAI/Anthropic)
        if (jsonStr === "[DONE]") {
          outputLines.push(line);
          continue;
        }
        try {
          const parsed = JSON.parse(jsonStr);
          const filtered = filterResponse(this.rules, this.method, this.urlPath, parsed, this.queryString);
          // Apply string-level replacements directly to the original JSON
          // to preserve the provider's exact formatting (whitespace, key order).
          // Re-serializing with JSON.stringify() produces compact JSON that
          // breaks some SDK incremental parsers (e.g., OpenClaw + Gemini SSE).
          outputLines.push(`data: ${applyJsonChanges(jsonStr, parsed, filtered)}`);
        } catch {
          // Not valid JSON — pass through unchanged
          outputLines.push(line);
        }
      } else {
        // event:, id:, retry:, comments (: prefix), empty lines — pass through
        outputLines.push(line);
      }
    }

    return outputLines.join("\n");
  }
}

/**
 * NDJSON stream filter.
 * Buffers until \n (line boundary), then processes each line as JSON.
 */
class NdjsonStreamFilter implements StreamFilter {
  private buffer = "";

  constructor(
    private rules: CompiledResponseRule[],
    private method: string,
    private urlPath: string,
    private queryString: string,
  ) {}

  transform(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline + 1); // include \n
      this.buffer = this.buffer.slice(newline + 1);
      output += this.processLine(line);
    }

    return output;
  }

  flush(): string | null {
    if (!this.buffer) return null;
    const remaining = this.buffer;
    this.buffer = "";
    return this.processLine(remaining);
  }

  private processLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return line; // preserve empty lines
    try {
      const parsed = JSON.parse(trimmed);
      const filtered = filterResponse(this.rules, this.method, this.urlPath, parsed, this.queryString);
      return applyJsonChanges(trimmed, parsed, filtered) + "\n";
    } catch {
      return line; // not JSON — pass through
    }
  }
}

/**
 * Text stream filter.
 * Applies PII redaction regex directly to each chunk.
 * No buffering needed — regex operates on the chunk as-is.
 *
 * Note: patterns spanning chunk boundaries may be missed. This is an
 * acceptable trade-off for streaming. The buffered path (non-streaming)
 * catches all patterns on the complete response.
 */
class TextStreamFilter implements StreamFilter {
  constructor(
    private rules: CompiledResponseRule[],
    private method: string,
    private urlPath: string,
    private queryString: string,
  ) {}

  transform(chunk: string): string {
    // filterResponse handles string inputs by applying redaction
    const filtered = filterResponse(this.rules, this.method, this.urlPath, chunk, this.queryString);
    return typeof filtered === "string" ? filtered : chunk;
  }

  flush(): null {
    return null;
  }
}
