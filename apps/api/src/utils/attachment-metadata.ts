/**
 * Attachment download metadata resolution.
 * For Gmail and Outlook attachment downloads, fetches the parent email's
 * subject, sender, and attachment filename so approval cards show useful context
 * instead of opaque message/attachment IDs.
 */

import type { FastifyBaseLogger } from "fastify";
import { request as undiciRequest } from "undici";

export interface AttachmentMetadata {
  messageSubject: string;
  messageSender: string;
  attachmentName?: string;
  attachmentSize?: number;
}

export interface EmailActionMetadata {
  messageId: string;
  messageSubject: string;
  messageSender: string;
  snippet?: string;
}

// Gmail: /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}
const GMAIL_ATTACHMENT_RE = /\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/?]+)/;
const GMAIL_MESSAGE_RE = /\/gmail\/v1\/users\/me\/messages\/([^/?]+?)(?:\/(trash|untrash))?$/;

// Outlook: /v1.0/me/messages/{messageId}/attachments/{attachmentId}
const OUTLOOK_ATTACHMENT_RE = /\/v1\.0\/me\/messages\/([^/]+)\/attachments\/([^/?]+)/;

export function isGmailAttachmentUrl(url: string): boolean {
  try {
    return GMAIL_ATTACHMENT_RE.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isOutlookAttachmentUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return OUTLOOK_ATTACHMENT_RE.test(pathname) && url.includes("graph.microsoft.com");
  } catch {
    return false;
  }
}

export function extractGmailAttachmentIds(url: string): { messageId: string; attachmentId: string } | null {
  try {
    const m = new URL(url).pathname.match(GMAIL_ATTACHMENT_RE);
    return m ? { messageId: m[1]!, attachmentId: m[2]! } : null;
  } catch {
    return null;
  }
}

export function extractGmailMessageAction(url: string): { messageId: string; action: "delete" | "trash" | "untrash" | "read" } | null {
  try {
    const m = new URL(url).pathname.match(GMAIL_MESSAGE_RE);
    if (!m) return null;
    const action = m[2] === "trash"
      ? "trash"
      : m[2] === "untrash"
        ? "untrash"
        : "read";
    return { messageId: m[1]!, action };
  } catch {
    return null;
  }
}

export function extractOutlookAttachmentIds(url: string): { messageId: string; attachmentId: string } | null {
  try {
    const m = new URL(url).pathname.match(OUTLOOK_ATTACHMENT_RE);
    return m ? { messageId: m[1]!, attachmentId: m[2]! } : null;
  } catch {
    return null;
  }
}

/**
 * Fetch parent email metadata from Gmail API.
 * Single call with `format=full` + field mask to get headers + part info.
 */
export async function resolveGmailAttachmentMetadata(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  log: FastifyBaseLogger,
): Promise<AttachmentMetadata | null> {
  try {
    const fetchUrl = `https://www.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full&fields=payload/headers,payload/parts(filename,body/attachmentId,body/size)`;

    const res = await undiciRequest(fetchUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }

    const body = await res.body.json() as GmailMessageResponse;
    const headers = body.payload?.headers ?? [];

    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "(No subject)";
    const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "(Unknown sender)";

    // Find the matching attachment part by attachmentId
    let attachmentName: string | undefined;
    let attachmentSize: number | undefined;

    const parts = body.payload?.parts ?? [];
    for (const part of parts) {
      if (part.body?.attachmentId === attachmentId) {
        if (part.filename) attachmentName = part.filename;
        if (part.body.size != null) attachmentSize = part.body.size;
        break;
      }
    }

    const result: AttachmentMetadata = { messageSubject: subject, messageSender: from };
    if (attachmentName) result.attachmentName = attachmentName;
    if (attachmentSize != null) result.attachmentSize = attachmentSize;
    return result;
  } catch (err) {
    log.debug({ err, messageId }, "vault.attachmentMetadata.gmailResolveFailed");
    return null;
  }
}

export async function resolveGmailMessageMetadata(
  accessToken: string,
  messageId: string,
  log: FastifyBaseLogger,
): Promise<EmailActionMetadata | null> {
  try {
    const fetchUrl =
      `https://www.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}` +
      "?format=metadata&metadataHeaders=Subject&metadataHeaders=From&fields=id,snippet,payload/headers";

    const res = await undiciRequest(fetchUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.statusCode !== 200) {
      const errBody = await res.body.text().catch(() => "");
      log.warn({ statusCode: res.statusCode, messageId, errBody: errBody.slice(0, 500) }, "vault.emailActionMetadata.gmailApiFailed");
      return null;
    }

    const body = await res.body.json() as GmailMessageResponse & { id?: string; snippet?: string };
    const headers = body.payload?.headers ?? [];

    const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value ?? "(No subject)";
    const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "(Unknown sender)";
    const snippet = typeof body.snippet === "string" && body.snippet.trim() ? body.snippet.trim() : undefined;

    return {
      messageId: body.id ?? messageId,
      messageSubject: subject,
      messageSender: from,
      ...(snippet ? { snippet } : {}),
    };
  } catch (err) {
    log.warn({ err, messageId }, "vault.emailActionMetadata.gmailResolveFailed");
    return null;
  }
}

/**
 * Fetch parent email metadata from Microsoft Graph API.
 * Single call: message subject + from + expanded attachments.
 */
export async function resolveOutlookAttachmentMetadata(
  accessToken: string,
  messageId: string,
  attachmentId: string,
  log: FastifyBaseLogger,
): Promise<AttachmentMetadata | null> {
  try {
    const fetchUrl = `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=subject,from&$expand=attachments($select=name,size,id)`;

    const res = await undiciRequest(fetchUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.statusCode !== 200) {
      await res.body.dump();
      return null;
    }

    const body = await res.body.json() as OutlookMessageResponse;

    const subject = body.subject ?? "(No subject)";
    const from = body.from?.emailAddress
      ? (body.from.emailAddress.name
        ? `${body.from.emailAddress.name} <${body.from.emailAddress.address}>`
        : body.from.emailAddress.address ?? "(Unknown sender)")
      : "(Unknown sender)";

    // Find matching attachment
    let attachmentName: string | undefined;
    let attachmentSize: number | undefined;

    const attachments = body.attachments ?? [];
    for (const att of attachments) {
      if (att.id === attachmentId) {
        if (att.name) attachmentName = att.name;
        if (att.size != null) attachmentSize = att.size;
        break;
      }
    }

    const result: AttachmentMetadata = { messageSubject: subject, messageSender: from };
    if (attachmentName) result.attachmentName = attachmentName;
    if (attachmentSize != null) result.attachmentSize = attachmentSize;
    return result;
  } catch (err) {
    log.debug({ err, messageId }, "vault.attachmentMetadata.outlookResolveFailed");
    return null;
  }
}

// ── Internal types for provider API responses ──

interface GmailMessageResponse {
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{
      filename?: string;
      body?: { attachmentId?: string; size?: number };
    }>;
  };
}

interface OutlookMessageResponse {
  subject?: string;
  from?: {
    emailAddress?: { name?: string; address?: string };
  };
  attachments?: Array<{
    id?: string;
    name?: string;
    size?: number;
  }>;
}
