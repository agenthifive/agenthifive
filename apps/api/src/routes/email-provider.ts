/**
 * Email Provider — IMAP/SMTP to REST translation layer.
 *
 * Translates REST-style requests from vault/execute into IMAP/SMTP
 * protocol operations. The agent sends JSON; this module talks IMAP.
 *
 * IMAP connections are created per request in the dispatcher and passed
 * to handlers. SMTP connections are transient.
 */
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { createTransport } from "nodemailer";
import type { FastifyBaseLogger } from "fastify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailCredentials {
  imap: { host: string; port: number; tls: boolean; username: string; password: string };
  smtp: { host: string; port: number; starttls: boolean; username: string; password: string };
  email: string;
  displayName?: string;
}

interface EmailResult {
  status: number;
  body: unknown;
  /** For attachment downloads — raw binary + headers */
  rawStream?: { stream: ReadableStream; contentType: string; filename: string };
}

interface AddressObject {
  name: string;
  address: string;
}

const consoleLogger = {
  level: "silent",
  silent: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => consoleLogger,
} as FastifyBaseLogger;

// ---------------------------------------------------------------------------
// IMAP Connection — connect per request, no pooling
// ---------------------------------------------------------------------------

/**
 * Create a fresh IMAP connection for each request.
 *
 * No connection pooling — long-lived IMAP sockets emit errors (timeouts,
 * resets) outside of request handling, which become uncaught exceptions
 * and crash the server. The 1-2s TLS handshake overhead per request is
 * acceptable for the safety guarantee.
 *
 * The caller MUST call client.close() when done (use try/finally).
 */
function createImapClient(
  creds: EmailCredentials["imap"],
  log: FastifyBaseLogger,
): ImapFlow {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });

  client.on("error", (err) => {
    log.warn({ err }, "email.imap.client_error");
  });

  return client;
}

async function connectImap(
  creds: EmailCredentials["imap"],
  log: FastifyBaseLogger,
): Promise<ImapFlow> {
  const client = createImapClient(creds, log);
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function handleEmailRequest(
  method: string,
  url: string,
  body: unknown,
  credentials: EmailCredentials,
  connectionId: string,
  log: FastifyBaseLogger,
  options?: { download?: boolean },
): Promise<EmailResult> {
  const parsed = new URL(url, "https://email-imap.internal");
  const path = parsed.pathname;
  const params = parsed.searchParams;

  // Send is SMTP-only — no IMAP connection needed
  if (method === "POST" && path === "/messages/send") {
    try {
      return await handleSendMessage(credentials, body as Record<string, unknown>, log);
    } catch (err) {
      return classifyEmailError(err, connectionId, method, path, log);
    }
  }

  // All other operations need IMAP. Connect once, use, disconnect.
  // No connection pooling — long-lived sockets emit uncaught errors that crash the server.
  let client: ImapFlow | null = null;
  try {
    client = await connectImap(credentials.imap, log);

    // Folders
    if (method === "GET" && path === "/folders") {
      return await handleListFolders(client, log);
    }
    if (method === "POST" && path === "/folders") {
      return await handleCreateFolder(client, body as Record<string, unknown>, log);
    }
    if (method === "DELETE" && path.startsWith("/folders/")) {
      const folderPath = decodeURIComponent(path.slice("/folders/".length));
      return await handleDeleteFolder(client, folderPath, log);
    }

    // Messages
    if (method === "GET" && path === "/messages") {
      const folder = params.get("folder") ?? "INBOX";
      const limit = parseInt(params.get("limit") ?? "20", 10);
      const offset = parseInt(params.get("offset") ?? "0", 10);
      const query = params.get("q") ?? null;
      const since = params.get("since") ?? null;
      const before = params.get("before") ?? null;
      return await handleListMessages(client, folder, { limit, offset, query: query ?? undefined, since: since ?? undefined, before: before ?? undefined }, log);
    }

    // Message by UID
    const messageMatch = path.match(/^\/messages\/(\d+)(\/.*)?$/);
    if (messageMatch) {
      const uid = parseInt(messageMatch[1]!, 10);
      const subpath = messageMatch[2] ?? "";
      const folder = params.get("folder") ?? "INBOX";

      if (method === "GET" && subpath === "") {
        return await handleReadMessage(client, credentials, folder, uid, log);
      }
      if (method === "GET" && subpath.startsWith("/attachments/")) {
        const partId = subpath.slice("/attachments/".length);
        return await handleDownloadAttachment(client, folder, uid, partId, log);
      }
      if (method === "POST" && subpath === "/reply") {
        return await handleReplyMessage(client, credentials, folder, uid, body as Record<string, unknown>, log);
      }
      if (method === "POST" && subpath === "/forward") {
        return await handleForwardMessage(client, credentials, folder, uid, body as Record<string, unknown>, log);
      }
      if (method === "POST" && subpath === "/move") {
        return await handleMoveMessage(client, folder, uid, body as Record<string, unknown>, log);
      }
      if (method === "POST" && subpath === "/copy") {
        return await handleCopyMessage(client, folder, uid, body as Record<string, unknown>, log);
      }
      if (method === "DELETE" && subpath === "") {
        return await handleDeleteMessage(client, folder, uid, log);
      }
      if (method === "PATCH" && subpath === "/flags") {
        return await handleUpdateFlags(client, folder, uid, body as Record<string, unknown>, log);
      }
    }

    return { status: 404, body: { error: `Unknown email endpoint: ${method} ${path}` } };
  } catch (err) {
    return classifyEmailError(err, connectionId, method, path, log);
  } finally {
    // Always tear down the socket immediately — no pooling, no lingering listeners.
    if (client) {
      try {
        client.close();
      } catch {}
    }
  }
}

function classifyEmailError(
  err: unknown,
  connectionId: string,
  method: string,
  path: string,
  log: FastifyBaseLogger,
): EmailResult {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err, connectionId, method, path }, "email.request.error");

  if (message.includes("Authentication") || message.includes("LOGIN")) {
    return { status: 401, body: { error: "Email authentication failed — check username and password" } };
  }
  if (message.includes("ECONNREFUSED") || message.includes("EHOSTUNREACH")) {
    return { status: 502, body: { error: `Cannot connect to email server: ${message}` } };
  }

  return { status: 500, body: { error: `Email operation failed: ${message}` } };
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

async function handleListFolders(
  client: ImapFlow,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const mailboxes = await client.list();

  const folders = mailboxes.map((mb) => ({
    name: mb.name,
    path: mb.path,
    delimiter: mb.delimiter,
    specialUse: mb.specialUse ?? null,
    flags: [...(mb.flags ?? [])],
  }));

  // Get message counts for each folder
  for (const folder of folders) {
    try {
      const status = await client.status(folder.path, { messages: true, unseen: true });
      (folder as Record<string, unknown>).totalMessages = status.messages;
      (folder as Record<string, unknown>).unseenMessages = status.unseen;
    } catch {
      // Some folders (e.g., \Noselect) can't be queried
    }
  }

  return { status: 200, body: { folders } };
}

async function handleCreateFolder(
  client: ImapFlow,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const name = body.name as string;
  if (!name) return { status: 400, body: { error: "Folder name is required" } };

  await client.mailboxCreate(name);
  return { status: 201, body: { created: true, path: name } };
}

async function handleDeleteFolder(
  client: ImapFlow,
  folderPath: string,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  await client.mailboxDelete(folderPath);
  return { status: 200, body: { deleted: true, path: folderPath } };
}

// ---------------------------------------------------------------------------
// Message listing + search
// ---------------------------------------------------------------------------

function parseSearchQuery(query?: string, since?: string, before?: string): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};

  if (since) criteria.since = new Date(since);
  if (before) criteria.before = new Date(before);

  if (!query) return Object.keys(criteria).length > 0 ? criteria : { all: true };

  // Parse human-readable query into IMAP search criteria
  const parts = query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  for (const part of parts) {
    if (part.startsWith("from:")) criteria.from = part.slice(5).replace(/"/g, "");
    else if (part.startsWith("to:")) criteria.to = part.slice(3).replace(/"/g, "");
    else if (part.startsWith("subject:")) criteria.subject = part.slice(8).replace(/"/g, "");
    else if (part.startsWith("body:")) criteria.body = part.slice(5).replace(/"/g, "");
    else if (part === "unseen") criteria.unseen = true;
    else if (part === "seen") criteria.seen = true;
    else if (part === "flagged") criteria.flagged = true;
    else if (part.startsWith("has:attachment")) criteria.header = { "Content-Type": "multipart/mixed" };
    else criteria.subject = part.replace(/"/g, ""); // Default to subject search
  }

  return Object.keys(criteria).length > 0 ? criteria : { all: true };
}

function parseAddress(addr: { name?: string; address?: string } | string | undefined): AddressObject | null {
  if (!addr) return null;
  if (typeof addr === "string") return { name: "", address: addr };
  return { name: addr.name ?? "", address: addr.address ?? "" };
}

function parseAddressList(addrs: unknown): AddressObject[] {
  if (!addrs) return [];
  if (Array.isArray(addrs)) return addrs.map(parseAddress).filter(Boolean) as AddressObject[];
  const single = parseAddress(addrs as { name?: string; address?: string });
  return single ? [single] : [];
}

function hasAttachments(struct?: MessageStructureObject): boolean {
  if (!struct) return false;
  if (struct.disposition === "attachment") return true;
  if (struct.childNodes) return struct.childNodes.some(hasAttachments);
  return false;
}

async function handleListMessages(
  client: ImapFlow,
  folder: string,
  opts: { limit: number; offset: number; query?: string | undefined; since?: string | undefined; before?: string | undefined },
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const lock = await client.getMailboxLock(folder);

  try {
    const searchCriteria = parseSearchQuery(opts.query, opts.since, opts.before);
    const searchResult = await client.search(searchCriteria, { uid: true });
    const uids: number[] = searchResult === false ? [] : searchResult;

    // Sort by UID descending (newest first) and paginate
    uids.sort((a: number, b: number) => b - a);
    const pageUids = uids.slice(opts.offset, opts.offset + opts.limit);

    if (pageUids.length === 0) {
      return { status: 200, body: { messages: [], total: uids.length, offset: opts.offset, limit: opts.limit } };
    }

    const messages: Record<string, unknown>[] = [];
    for await (const msg of client.fetch(pageUids, {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      bodyStructure: true,
    }, { uid: true })) {
      messages.push({
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? null,
        date: msg.envelope?.date?.toISOString() ?? null,
        from: parseAddress(msg.envelope?.from?.[0]),
        to: parseAddressList(msg.envelope?.to),
        cc: parseAddressList(msg.envelope?.cc),
        subject: msg.envelope?.subject ?? null,
        flags: [...(msg.flags ?? [])],
        hasAttachments: hasAttachments(msg.bodyStructure),
        size: msg.size ?? 0,
      });
    }

    return { status: 200, body: { messages, total: uids.length, offset: opts.offset, limit: opts.limit } };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Read message
// ---------------------------------------------------------------------------

async function handleReadMessage(
  client: ImapFlow,
  credentials: EmailCredentials,
  folder: string,
  uid: number,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const lock = await client.getMailboxLock(folder);

  try {
    let msg: FetchMessageObject | undefined;
    for await (const m of client.fetch([uid], {
      uid: true,
      envelope: true,
      flags: true,
      size: true,
      bodyStructure: true,
      source: true,
    }, { uid: true })) {
      msg = m;
    }

    if (!msg) {
      return { status: 404, body: { error: `Message ${uid} not found in ${folder}` } };
    }

    // Parse the raw source to extract text and HTML bodies
    const mailparser = await import("mailparser");
    if (!msg.source) {
      return { status: 500, body: { error: "Failed to fetch message source" } };
    }
    const parsed = await mailparser.simpleParser(msg.source);

    const attachments = (parsed.attachments ?? []).map((att, i) => ({
      filename: att.filename ?? `attachment-${i}`,
      contentType: att.contentType,
      size: att.size,
      partId: String(i + 1),
    }));

    return {
      status: 200,
      body: {
        uid: msg.uid,
        messageId: msg.envelope?.messageId ?? null,
        date: msg.envelope?.date?.toISOString() ?? null,
        from: parseAddress(msg.envelope?.from?.[0]),
        to: parseAddressList(msg.envelope?.to),
        cc: parseAddressList(msg.envelope?.cc),
        subject: msg.envelope?.subject ?? null,
        textBody: parsed.text ?? null,
        htmlBody: parsed.html ?? null,
        flags: [...(msg.flags ?? [])],
        headers: {
          "in-reply-to": msg.envelope?.inReplyTo ?? null,
          references: parsed.references ? (Array.isArray(parsed.references) ? parsed.references.join(" ") : parsed.references) : null,
        },
        attachments,
      },
    };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Download attachment
// ---------------------------------------------------------------------------

async function handleDownloadAttachment(
  client: ImapFlow,
  folder: string,
  uid: number,
  partId: string,
  log: FastifyBaseLogger,
  options?: { download?: boolean },
): Promise<EmailResult> {
  const lock = await client.getMailboxLock(folder);

  try {
    // Fetch the full message and extract the attachment
    let msg: FetchMessageObject | undefined;
    for await (const m of client.fetch([uid], { uid: true, source: true }, { uid: true })) {
      msg = m;
    }

    if (!msg) {
      return { status: 404, body: { error: `Message ${uid} not found` } };
    }

    const mailparser = await import("mailparser");
    if (!msg.source) {
      return { status: 500, body: { error: "Failed to fetch message source" } };
    }
    const parsed = await mailparser.simpleParser(msg.source);
    const decodedPartId = decodeURIComponent(partId);
    const att = parsed.attachments?.[parseInt(decodedPartId, 10) - 1];

    if (!att) {
      return { status: 404, body: { error: `Attachment ${partId} not found in message ${uid}` } };
    }

    // Guard against large attachments that would blow up the JSON response
    // and corrupt the agent's context window. 512KB raw = ~680KB base64.
    // Skip when download: true — the vault will decode base64 and stream raw binary.
    const MAX_ATTACHMENT_SIZE = 512 * 1024;
    if (!options?.download && att.size > MAX_ATTACHMENT_SIZE) {
      return {
        status: 200,
        body: {
          filename: att.filename ?? "attachment",
          contentType: att.contentType,
          size: att.size,
          content: null,
          truncated: true,
          message: `Attachment is too large for JSON transport (${(att.size / 1024).toFixed(0)}KB). Use vault_download for binary files, or ask the user to access the email directly.`,
        },
      };
    }

    // Return base64-encoded content for JSON transport
    return {
      status: 200,
      body: {
        filename: att.filename ?? "attachment",
        contentType: att.contentType,
        size: att.size,
        content: att.content.toString("base64"),
      },
    };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Send / Reply / Forward
// ---------------------------------------------------------------------------

async function handleSendMessage(
  credentials: EmailCredentials,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const transport = createTransport({
    host: credentials.smtp.host,
    port: credentials.smtp.port,
    secure: credentials.smtp.port === 465,
    requireTLS: credentials.smtp.starttls,
    auth: {
      user: credentials.smtp.username,
      pass: credentials.smtp.password,
    },
  });

  try {
    const to = body.to as AddressObject[] | undefined;
    if (!to || to.length === 0) {
      return { status: 400, body: { error: "At least one recipient (to) is required" } };
    }

    const info = await transport.sendMail({
      from: body.from as string ?? `${credentials.displayName ?? ""} <${credentials.email}>`,
      to: to.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", "),
      cc: (body.cc as AddressObject[] ?? []).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ") || undefined,
      bcc: (body.bcc as AddressObject[] ?? []).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).join(", ") || undefined,
      subject: body.subject as string ?? "",
      text: body.textBody as string ?? undefined,
      html: body.htmlBody as string ?? undefined,
      replyTo: body.replyTo as string ?? undefined,
      inReplyTo: body.inReplyTo as string ?? undefined,
      references: body.references as string ?? undefined,
      attachments: (body.attachments as Array<{ filename: string; contentType: string; content: string }> ?? []).map((att) => ({
        filename: att.filename,
        contentType: att.contentType,
        content: Buffer.from(att.content, "base64"),
      })),
    });

    log.info({ messageId: info.messageId, to: to.map((a) => a.address) }, "email.smtp.sent");

    return {
      status: 200,
      body: { sent: true, messageId: info.messageId },
    };
  } finally {
    transport.close();
  }
}

async function handleReplyMessage(
  client: ImapFlow,
  credentials: EmailCredentials,
  folder: string,
  uid: number,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  // Fetch original message for reply headers
  const original = await handleReadMessage(client, credentials, folder, uid, log);
  if (original.status !== 200) return original;

  const orig = original.body as Record<string, unknown>;
  const replyAll = body.replyAll === true;

  // Build recipient list
  const from = orig.from as AddressObject | null;
  const to: AddressObject[] = from ? [from] : [];
  if (replyAll) {
    const origTo = (orig.to as AddressObject[] ?? []).filter((a) => a.address !== credentials.email);
    const origCc = (orig.cc as AddressObject[] ?? []).filter((a) => a.address !== credentials.email);
    to.push(...origTo);
    if (origCc.length > 0) {
      (body as Record<string, unknown>).cc = origCc;
    }
  }

  const origSubject = (orig.subject as string) ?? "";
  const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
  const headers = orig.headers as Record<string, string | null> | undefined;

  return await handleSendMessage(credentials, {
    ...body,
    to,
    subject,
    inReplyTo: orig.messageId,
    references: [headers?.references, orig.messageId].filter(Boolean).join(" "),
  }, log);
}

async function handleForwardMessage(
  client: ImapFlow,
  credentials: EmailCredentials,
  folder: string,
  uid: number,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const original = await handleReadMessage(client, credentials, folder, uid, log);
  if (original.status !== 200) return original;

  const orig = original.body as Record<string, unknown>;
  const origSubject = (orig.subject as string) ?? "";
  const subject = origSubject.startsWith("Fwd:") ? origSubject : `Fwd: ${origSubject}`;

  const forwardPrefix = `\n---------- Forwarded message ----------\nFrom: ${(orig.from as AddressObject)?.address ?? "unknown"}\nDate: ${orig.date ?? ""}\nSubject: ${origSubject}\n\n`;

  const textBody = (body.textBody as string ?? "") + forwardPrefix + (orig.textBody as string ?? "");

  return await handleSendMessage(credentials, {
    ...body,
    subject,
    textBody,
  }, log);
}

// ---------------------------------------------------------------------------
// Message management
// ---------------------------------------------------------------------------

async function handleMoveMessage(
  client: ImapFlow,
  folder: string,
  uid: number,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const destination = body.destination as string;
  if (!destination) return { status: 400, body: { error: "Destination folder is required" } };

  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageMove([uid], destination, { uid: true });
    return { status: 200, body: { moved: true, from: folder, to: destination } };
  } finally {
    lock.release();
  }
}

async function handleCopyMessage(
  client: ImapFlow,
  folder: string,
  uid: number,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const destination = body.destination as string;
  if (!destination) return { status: 400, body: { error: "Destination folder is required" } };

  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageCopy([uid], destination, { uid: true });
    return { status: 200, body: { copied: true, from: folder, to: destination } };
  } finally {
    lock.release();
  }
}

async function handleDeleteMessage(
  client: ImapFlow,
  folder: string,
  uid: number,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageDelete([uid], { uid: true });
    return { status: 200, body: { deleted: true, uid } };
  } finally {
    lock.release();
  }
}

async function handleUpdateFlags(
  client: ImapFlow,
  folder: string,
  uid: number,
  body: Record<string, unknown>,
  log: FastifyBaseLogger,
): Promise<EmailResult> {
  const lock = await client.getMailboxLock(folder);
  try {
    const add = body.add as string[] | undefined;
    const remove = body.remove as string[] | undefined;

    if (add?.length) {
      await client.messageFlagsAdd([uid], add, { uid: true });
    }
    if (remove?.length) {
      await client.messageFlagsRemove([uid], remove, { uid: true });
    }

    return { status: 200, body: { updated: true, uid, flagsAdded: add ?? [], flagsRemoved: remove ?? [] } };
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Connection validation (used during connection creation)
// ---------------------------------------------------------------------------

export async function validateEmailConnection(credentials: EmailCredentials): Promise<{ valid: boolean; error?: string }> {
  // Test IMAP
  try {
    const client = createImapClient(credentials.imap, consoleLogger);
    await client.connect();
    await client.list();
    client.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Authentication") || msg.includes("LOGIN")) {
      return { valid: false, error: "IMAP authentication failed — check username and password" };
    }
    return { valid: false, error: `IMAP connection failed: ${msg}` };
  }

  // Test SMTP
  try {
    const transport = createTransport({
      host: credentials.smtp.host,
      port: credentials.smtp.port,
      secure: credentials.smtp.port === 465,
      requireTLS: credentials.smtp.starttls,
      auth: { user: credentials.smtp.username, pass: credentials.smtp.password },
    });
    await transport.verify();
    transport.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Authentication") || msg.includes("auth")) {
      return { valid: false, error: "SMTP authentication failed — check username and password" };
    }
    return { valid: false, error: `SMTP connection failed: ${msg}` };
  }

  return { valid: true };
}
