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
          // Only re-serialize if the filter actually changed the content.
          // This preserves the original JSON formatting (whitespace, key order)
          // which some SDKs rely on for incremental/streaming parsing.
          const reserialized = JSON.stringify(filtered);
          if (reserialized === JSON.stringify(parsed)) {
            outputLines.push(line);
          } else {
            outputLines.push(`data: ${reserialized}`);
          }
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
      const reserialized = JSON.stringify(filtered);
      // Preserve original formatting if content unchanged
      if (reserialized === JSON.stringify(parsed)) return line;
      return reserialized + "\n";
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
