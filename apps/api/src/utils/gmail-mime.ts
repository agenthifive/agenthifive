/**
 * Gmail MIME parsing utility.
 * Parses base64url-encoded RFC 2822 messages from Gmail API send payloads
 * to extract recipient, subject, and body preview for human-readable approval display.
 */

export interface GmailEmailMetadata {
  to: string[];
  cc: string[];
  from: string;
  subject: string;
  bodyPreview: string;
}

const GMAIL_SEND_PATH = "/gmail/v1/users/me/messages/send";

/**
 * Check if a URL targets the Gmail send endpoint.
 */
export function isGmailSendUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname === GMAIL_SEND_PATH;
  } catch {
    return false;
  }
}

/**
 * Extract email metadata from a Gmail send request body.
 * The Gmail API accepts `{ raw: "<base64url-encoded RFC 2822 message>" }`.
 * Returns null if the body doesn't contain a parseable `raw` field.
 */
export function parseGmailSendPayload(requestBody: unknown): GmailEmailMetadata | null {
  if (!requestBody || typeof requestBody !== "object") return null;

  const body = requestBody as Record<string, unknown>;
  const raw = body["raw"];
  if (typeof raw !== "string" || raw.length === 0) return null;

  try {
    // Decode base64url to string
    const decoded = Buffer.from(raw, "base64url").toString("utf-8");
    return parseRfc2822(decoded);
  } catch {
    return null;
  }
}

/**
 * Parse an RFC 2822 email message string to extract headers and body preview.
 */
function parseRfc2822(message: string): GmailEmailMetadata {
  // RFC 2822: headers and body are separated by a blank line (CRLFCRLF or LFLF)
  const headerBodySeparator = message.indexOf("\r\n\r\n");
  const altSeparator = message.indexOf("\n\n");

  let headerSection: string;
  let bodySection: string;

  if (headerBodySeparator !== -1 && (altSeparator === -1 || headerBodySeparator < altSeparator)) {
    headerSection = message.substring(0, headerBodySeparator);
    bodySection = message.substring(headerBodySeparator + 4);
  } else if (altSeparator !== -1) {
    headerSection = message.substring(0, altSeparator);
    bodySection = message.substring(altSeparator + 2);
  } else {
    // No body separator found — treat entire message as headers
    headerSection = message;
    bodySection = "";
  }

  // Unfold header continuation lines (lines starting with whitespace are continuations)
  const unfoldedHeaders = headerSection.replace(/\r?\n[ \t]+/g, " ");
  const headerLines = unfoldedHeaders.split(/\r?\n/);

  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const name = line.substring(0, colonIndex).trim().toLowerCase();
    const value = line.substring(colonIndex + 1).trim();
    headers[name] = value;
  }

  const to = parseAddressList(headers["to"] ?? "");
  const cc = parseAddressList(headers["cc"] ?? "");
  const from = headers["from"] ?? "";
  const subject = decodeRfc2047(headers["subject"] ?? "(No subject)");

  // Extract body preview — handle multipart and plain text
  const contentType = headers["content-type"] ?? "text/plain";
  let bodyPreview = extractBodyPreview(bodySection, contentType);

  // Truncate body preview to a reasonable length
  const MAX_PREVIEW_LENGTH = 500;
  if (bodyPreview.length > MAX_PREVIEW_LENGTH) {
    bodyPreview = bodyPreview.substring(0, MAX_PREVIEW_LENGTH) + "...";
  }

  return { to, cc, from, subject, bodyPreview };
}

/**
 * Parse a comma-separated address list (e.g., "Foo <foo@bar.com>, baz@qux.com").
 */
function parseAddressList(header: string): string[] {
  if (!header.trim()) return [];
  return header.split(",").map((addr) => addr.trim()).filter(Boolean);
}

/**
 * Decode RFC 2047 encoded-words in header values (e.g., =?UTF-8?B?...?= or =?UTF-8?Q?...?=).
 */
function decodeRfc2047(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]+)\?=/g, (_, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(encoded, "base64").toString(charset.toLowerCase() === "utf-8" ? "utf-8" : "latin1");
      }
      if (encoding.toUpperCase() === "Q") {
        // Quoted-printable: _ is space, =XX is hex
        const decoded = encoded
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        return decoded;
      }
    } catch {
      // Fall through to return original
    }
    return value;
  });
}

/**
 * Extract a text preview from the email body.
 * Handles simple text/plain and basic multipart/mixed or multipart/alternative.
 */
function extractBodyPreview(body: string, contentType: string): string {
  const ct = contentType.toLowerCase();

  // For multipart messages, try to find the text/plain part
  if (ct.includes("multipart/")) {
    const boundaryMatch = ct.match(/boundary=["']?([^"';\s]+)["']?/);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(`--${boundary}`);

      // Look for text/plain part first, then text/html
      for (const part of parts) {
        if (part.trim() === "--" || part.trim() === "") continue;

        const partSep = part.indexOf("\r\n\r\n") !== -1
          ? part.indexOf("\r\n\r\n")
          : part.indexOf("\n\n");

        if (partSep === -1) continue;

        const partHeaders = part.substring(0, partSep).toLowerCase();
        const partBody = part.substring(partSep + (part.indexOf("\r\n\r\n") !== -1 ? 4 : 2));

        if (partHeaders.includes("text/plain")) {
          return decodePartBody(partBody.trim(), partHeaders);
        }
      }

      // Fallback: try text/html and strip tags
      for (const part of parts) {
        if (part.trim() === "--" || part.trim() === "") continue;

        const partSep = part.indexOf("\r\n\r\n") !== -1
          ? part.indexOf("\r\n\r\n")
          : part.indexOf("\n\n");

        if (partSep === -1) continue;

        const partHeaders = part.substring(0, partSep).toLowerCase();
        const partBody = part.substring(partSep + (part.indexOf("\r\n\r\n") !== -1 ? 4 : 2));

        if (partHeaders.includes("text/html")) {
          return stripHtml(decodePartBody(partBody.trim(), partHeaders));
        }
      }
    }
  }

  // For text/html, strip tags
  if (ct.includes("text/html")) {
    return stripHtml(body.trim());
  }

  // Default: treat as text/plain
  return body.trim();
}

/**
 * Decode a MIME part body based on Content-Transfer-Encoding.
 */
function decodePartBody(body: string, partHeaders: string): string {
  if (partHeaders.includes("base64")) {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch {
      return body;
    }
  }
  if (partHeaders.includes("quoted-printable")) {
    return body
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
  }
  return body;
}

/**
 * Strip HTML tags for a simple text preview.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
