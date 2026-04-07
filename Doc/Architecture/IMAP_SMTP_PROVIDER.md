# IMAP/SMTP Email Provider — Design Document

> **Status**: Proposal
> **Date**: April 2026
> **Author**: Engineering

---

## 1. Summary

Add a new connection type to AgentHiFive that connects to any IMAP/SMTP email server and exposes a REST API to agents. The vault translates REST calls to IMAP/SMTP protocol commands, so agents interact with email using the same `POST /v1/vault/execute` endpoint they use for Gmail, Slack, and other providers. No IMAP libraries or credentials on the agent host.

This enables vault-managed access to **any email provider** — not just Google and Microsoft — including self-hosted mail (Postfix, Dovecot), iCloud, Fastmail, ProtonMail Bridge, corporate Exchange (IMAP), and legacy POP3 systems.

## 2. Motivation

### Current state

| Provider | AgentHiFive Support | Protocol | Agent Access |
|----------|-------------------|----------|--------------|
| Gmail | Yes (google-gmail) | Google REST API | vault_execute → REST |
| Outlook | Yes (microsoft-outlook-mail) | Microsoft Graph API | vault_execute → REST |
| Any IMAP server | **No** | IMAP/SMTP | Not supported |

### Gap

OpenClaw agents use `himalaya` (CLI email client) for IMAP/SMTP access. This requires:
- IMAP/SMTP credentials stored locally on the agent host
- himalaya binary installed
- No vault policy enforcement, audit logging, or PII redaction

### Opportunity

A vault-native IMAP/SMTP provider would:
- Keep credentials off the agent host (same as Gmail/Outlook)
- Apply the full policy engine (allowlists, PII redaction, rate limits, approval)
- Audit every email operation
- Work with OpenClaw via the existing `vault_execute` tool (no new tools needed)
- Support any IMAP/SMTP server (not tied to Google or Microsoft)

## 3. Architecture

```
Agent / OpenClaw                AgentHiFive Vault                 Mail Server
                                                                  
POST /v1/vault/execute    ┌─────────────────────┐          ┌──────────────┐
  service: "email"        │  Email Provider      │          │ IMAP Server  │
  method: "GET"           │  ──────────────────  │  IMAP    │ (port 993)   │
  url: "/messages"   ───▶ │  REST → IMAP         │ ───────▶ │              │
                          │  translator          │          └──────────────┘
                          │                      │
POST /v1/vault/execute    │                      │          ┌──────────────┐
  method: "POST"          │  REST → SMTP         │  SMTP    │ SMTP Server  │
  url: "/messages/send"   │  translator          │ ───────▶ │ (port 587)   │
                     ───▶ │                      │          └──────────────┘
                          │  ┌──────────────┐    │
                          │  │ Policy Engine │    │
                          │  │ PII Redaction │    │
                          │  │ Rate Limits   │    │
                          │  │ Audit Log     │    │
                          │  └──────────────┘    │
                          └─────────────────────┘
```

The vault maintains IMAP connections server-side with connection pooling. The agent sends stateless REST requests. The vault translates, executes, and returns JSON responses.

## 4. Connection Configuration

### New service: `email-imap`

```typescript
// Service catalog entry
"email-imap": {
  provider: "email",
  displayName: "Email (IMAP/SMTP)",
  icon: "📧",
  description: "Connect to any email server via IMAP and SMTP",
  group: "Communication",
  category: "data",
  singleton: false,         // Multiple email accounts per workspace
  credentialType: "email",  // New credential type
  allowedModels: ["B"],     // Model B only — no credential vending for IMAP
}
```

### Credential storage

Encrypted in `t_connections.encryptedTokens` (same as all other providers):

```json
{
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "tls": true,
    "username": "user@example.com",
    "password": "app-password-or-regular"
  },
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "starttls": true,
    "username": "user@example.com",
    "password": "app-password-or-regular"
  },
  "email": "user@example.com",
  "displayName": "User Name"
}
```

### Dashboard UI

New connection form fields:
- Email address
- Display name
- IMAP host, port, TLS toggle
- SMTP host, port, STARTTLS toggle
- Username (defaults to email)
- Password
- "Test Connection" button (validates IMAP login + SMTP EHLO)

Provider presets for providers that support standard IMAP/SMTP authentication (Gmail and Outlook require OAuth — use their dedicated connections instead):

| Provider | IMAP Host | SMTP Host | Notes |
|----------|-----------|-----------|-------|
| Fastmail | imap.fastmail.com:993 | smtp.fastmail.com:587 | |
| iCloud | imap.mail.me.com:993 | smtp.mail.me.com:587 | Requires app-specific password |
| Custom | User-provided | User-provided | Self-hosted, ProtonMail Bridge, etc. |

## 5. REST API Surface

All operations go through `POST /v1/vault/execute` with `service: "email-imap"` and `model: "B"`.

### 5.1 Folders

**List folders**
```json
{ "method": "GET", "url": "/folders" }
```
Response:
```json
{
  "folders": [
    { "name": "INBOX", "path": "INBOX", "specialUse": "\\Inbox", "totalMessages": 1234, "unseenMessages": 5 },
    { "name": "Sent", "path": "Sent", "specialUse": "\\Sent", "totalMessages": 567 },
    { "name": "Drafts", "path": "Drafts", "specialUse": "\\Drafts", "totalMessages": 2 },
    { "name": "Trash", "path": "Trash", "specialUse": "\\Trash", "totalMessages": 89 },
    { "name": "Projects/Alpha", "path": "Projects/Alpha", "totalMessages": 42 }
  ]
}
```

**Create folder**
```json
{ "method": "POST", "url": "/folders", "body": { "name": "Projects/Beta" } }
```

**Delete folder**
```json
{ "method": "DELETE", "url": "/folders/Projects%2FBeta" }
```

### 5.2 Messages (envelope listing)

**List messages**
```json
{ "method": "GET", "url": "/messages?folder=INBOX&limit=20&offset=0" }
```
Response:
```json
{
  "messages": [
    {
      "uid": 12345,
      "messageId": "<abc@example.com>",
      "date": "2026-04-06T10:30:00Z",
      "from": { "name": "Bob Smith", "address": "bob@example.com" },
      "to": [{ "name": "You", "address": "you@example.com" }],
      "cc": [],
      "subject": "Meeting tomorrow",
      "flags": ["\\Seen"],
      "hasAttachments": true,
      "size": 15234,
      "preview": "Hi, just wanted to confirm..."
    }
  ],
  "total": 1234,
  "offset": 0,
  "limit": 20
}
```

**Search messages**
```json
{ "method": "GET", "url": "/messages?folder=INBOX&q=from:bob subject:meeting&since=2026-04-01" }
```

Query parameter `q` supports IMAP SEARCH syntax mapped to human-readable format:
- `from:addr` → IMAP `FROM "addr"`
- `to:addr` → IMAP `TO "addr"`
- `subject:text` → IMAP `SUBJECT "text"`
- `body:text` → IMAP `BODY "text"`
- `since:date` → IMAP `SINCE date`
- `before:date` → IMAP `BEFORE date`
- `unseen` → IMAP `UNSEEN`
- `flagged` → IMAP `FLAGGED`
- `has:attachment` → IMAP messages with Content-Type multipart/mixed

### 5.3 Message content

**Read message**
```json
{ "method": "GET", "url": "/messages/12345?folder=INBOX" }
```
Response:
```json
{
  "uid": 12345,
  "messageId": "<abc@example.com>",
  "date": "2026-04-06T10:30:00Z",
  "from": { "name": "Bob Smith", "address": "bob@example.com" },
  "to": [{ "name": "You", "address": "you@example.com" }],
  "cc": [],
  "subject": "Meeting tomorrow",
  "textBody": "Hi, just wanted to confirm our meeting at 3pm...",
  "htmlBody": "<html><body><p>Hi, just wanted to confirm...</p></body></html>",
  "flags": ["\\Seen"],
  "headers": {
    "in-reply-to": "<prev@example.com>",
    "references": "<thread@example.com>"
  },
  "attachments": [
    { "filename": "agenda.pdf", "contentType": "application/pdf", "size": 45678, "partId": "2" }
  ]
}
```

**Download attachment**
```json
{ "method": "GET", "url": "/messages/12345/attachments/2?folder=INBOX" }
```
Response: raw binary with Content-Type and Content-Disposition headers.

### 5.4 Send / Reply / Forward

**Send new message**
```json
{
  "method": "POST",
  "url": "/messages/send",
  "body": {
    "to": [{ "address": "recipient@example.com", "name": "Recipient" }],
    "cc": [],
    "bcc": [],
    "subject": "Hello from the vault",
    "textBody": "This is the plain text body.",
    "htmlBody": "<p>This is the <b>HTML</b> body.</p>",
    "replyTo": "you@example.com",
    "attachments": [
      { "filename": "report.pdf", "contentType": "application/pdf", "content": "<base64>" }
    ]
  }
}
```

**Reply to message**
```json
{
  "method": "POST",
  "url": "/messages/12345/reply?folder=INBOX",
  "body": {
    "textBody": "Thanks Bob, 3pm works for me.",
    "replyAll": false
  }
}
```
The vault auto-populates `To`, `Subject` (Re:), `In-Reply-To`, and `References` headers from the original message.

**Forward message**
```json
{
  "method": "POST",
  "url": "/messages/12345/forward?folder=INBOX",
  "body": {
    "to": [{ "address": "alice@example.com" }],
    "textBody": "FYI — see below."
  }
}
```
The vault includes the original message body and attachments.

### 5.5 Message management

**Move message**
```json
{ "method": "POST", "url": "/messages/12345/move?folder=INBOX", "body": { "destination": "Archive" } }
```

**Copy message**
```json
{ "method": "POST", "url": "/messages/12345/copy?folder=INBOX", "body": { "destination": "Important" } }
```

**Delete message**
```json
{ "method": "DELETE", "url": "/messages/12345?folder=INBOX" }
```

**Update flags**
```json
{
  "method": "PATCH",
  "url": "/messages/12345/flags?folder=INBOX",
  "body": { "add": ["\\Seen", "\\Flagged"], "remove": ["\\Draft"] }
}
```

**Batch operations**
```json
{
  "method": "POST",
  "url": "/messages/batch/move?folder=INBOX",
  "body": { "uids": [12345, 12346, 12347], "destination": "Archive" }
}
```

## 6. Implementation

### 6.1 Server-side IMAP client

Use **imapflow** (MIT license, modern async/await API):

```typescript
import { ImapFlow } from "imapflow";

// Connection pool per workspace connection
const pool = new Map<string, ImapFlow>();

async function getClient(connectionId: string, credentials: ImapCredentials): Promise<ImapFlow> {
  const existing = pool.get(connectionId);
  if (existing && existing.usable) return existing;

  const client = new ImapFlow({
    host: credentials.imap.host,
    port: credentials.imap.port,
    secure: credentials.imap.tls,
    auth: {
      user: credentials.imap.username,
      pass: credentials.imap.password,
    },
    logger: false,
  });

  await client.connect();
  pool.set(connectionId, client);
  return client;
}
```

Connection lifecycle:
- **Create on first request** for a connection
- **Keep alive** with IMAP IDLE (no polling needed — server pushes notifications)
- **Reconnect on error** (auth failure → mark connection needs_reauth)
- **Idle timeout** (close after 10 minutes of inactivity)
- **Pool size limit** per vault replica (prevent resource exhaustion)

### 6.2 SMTP client

Use **nodemailer** (already a dependency for transactional emails):

```typescript
import { createTransport } from "nodemailer";

function createSmtpTransport(credentials: SmtpCredentials) {
  return createTransport({
    host: credentials.smtp.host,
    port: credentials.smtp.port,
    secure: credentials.smtp.port === 465,
    auth: {
      user: credentials.smtp.username,
      pass: credentials.smtp.password,
    },
  });
}
```

### 6.3 Route handler

New route file: `apps/api/src/routes/email-provider.ts`

```typescript
// Registered in vault.ts as a provider-specific handler
// Called when service === "email-imap"

async function handleEmailRequest(
  method: string,
  url: string,
  body: unknown,
  connection: ConnectionRow,
  ctx: ModelBContext,
): Promise<{ status: number; body: unknown }> {
  const credentials = decryptEmailCredentials(connection.encryptedTokens);
  const parsed = new URL(url, "http://localhost");
  const path = parsed.pathname;
  const folder = parsed.searchParams.get("folder") ?? "INBOX";

  if (method === "GET" && path === "/folders") {
    return handleListFolders(credentials);
  }
  if (method === "GET" && path === "/messages") {
    return handleListMessages(credentials, folder, parsed.searchParams);
  }
  if (method === "GET" && path.match(/^\/messages\/\d+$/)) {
    return handleReadMessage(credentials, folder, parseInt(path.split("/")[2]!));
  }
  if (method === "POST" && path === "/messages/send") {
    return handleSendMessage(credentials, body);
  }
  // ... etc
}
```

### 6.4 Policy integration

The email provider integrates with the existing policy engine:

**Allowlist templates** (`allowlist-templates.ts`):
```typescript
"email-imap": [
  {
    baseUrl: "imap://provider",  // Virtual base URL for policy matching
    methods: ["GET", "POST", "DELETE", "PATCH"],
    pathPatterns: [
      "/folders",
      "/messages",
      "/messages/*",
      "/messages/*/reply",
      "/messages/*/forward",
      "/messages/*/move",
      "/messages/*/copy",
      "/messages/*/flags",
      "/messages/*/attachments/*",
      "/messages/send",
      "/messages/batch/*",
    ],
  },
],
```

**Security presets**:
- **Strict**: Read-only (GET only), no send/delete/move, PII redacted
- **Standard (Balanced)**: Read + send, approval required for delete/batch, PII redacted in responses
- **Minimal**: Full access, no approval

**PII redaction** works out of the box — the response JSON contains text fields (`textBody`, `from.address`, etc.) that the existing PII scanner processes.

**Step-up approval** for sensitive operations:
- Send to external domains → require approval
- Delete messages → require approval
- Batch operations → require approval

### 6.5 Audit logging

Every IMAP/SMTP operation is logged to `l_audit_events`:

```json
{
  "action": "email_messages_list",
  "decision": "allowed",
  "metadata": {
    "folder": "INBOX",
    "resultCount": 20,
    "provider": "email"
  }
}
```

```json
{
  "action": "email_message_send",
  "decision": "allowed",
  "metadata": {
    "to": ["recipient@example.com"],
    "subject": "Hello",
    "hasAttachments": false,
    "provider": "email"
  }
}
```

## 7. Connection Validation

When creating an email connection, the vault validates:

1. **IMAP login** — connect, authenticate, list INBOX, disconnect
2. **SMTP EHLO** — connect, authenticate, verify sender address is accepted

If either fails, return 400 with a clear error:
- "IMAP authentication failed — check username and password"
- "IMAP connection failed — check host and port"
- "SMTP authentication failed"
- "SMTP connection refused — check host and port"
- "Certificate error — the server's TLS certificate is not trusted"

## 8. OpenClaw Integration

### Agent usage via vault_execute

OpenClaw agents use the standard `vault_execute` tool:

```
Agent: "Check my inbox for emails from Bob"

Tool call: vault_execute
  service: "email-imap"
  method: "GET"
  url: "/messages?folder=INBOX&q=from:bob@example.com&limit=5"

Result: { messages: [...] }
```

### Himalaya replacement

With this provider, agents no longer need the himalaya binary. The vault provides the same functionality via REST:

| Himalaya CLI | vault_execute equivalent |
|---|---|
| `himalaya envelope list` | `GET /messages?folder=INBOX` |
| `himalaya message read 42` | `GET /messages/42` |
| `himalaya message write` | `POST /messages/send` |
| `himalaya message reply 42` | `POST /messages/42/reply` |
| `himalaya message move 42 Archive` | `POST /messages/42/move` |
| `himalaya folder list` | `GET /folders` |
| `himalaya envelope list from bob` | `GET /messages?q=from:bob` |
| `himalaya attachment download 42` | `GET /messages/42/attachments/1` |

### Plugin reference files

The AgentHiFive plugin's chunked reference files would include email-imap examples alongside existing Gmail/Outlook examples, so the LLM knows the available endpoints.

## 9. Future Extensions

### IDLE-based notifications (inbound email watching)

IMAP IDLE allows the server to push new-message notifications. The vault could:
1. Maintain an IDLE connection per email connection
2. When a new message arrives, notify the workspace via the existing notification system
3. The agent can then fetch the message via vault_execute

This mirrors the Gmail webhook watcher pattern but uses standard IMAP IDLE instead of Google's push notification API.

### POP3 support

POP3 is simpler than IMAP (no folders, no flags, download-and-delete). Could be added as a variant with a reduced API surface:
- `GET /messages` (list)
- `GET /messages/{id}` (read + download)
- `DELETE /messages/{id}` (delete from server)

### OAuth2 for IMAP

Some providers (Gmail, Outlook) support OAuth2 XOAUTH2 for IMAP authentication. The vault could use the existing OAuth connection's access token for IMAP login, eliminating the need for app passwords.

## 10. Implementation Plan

### Phase 1: Core (MVP)
- [ ] Service catalog entry (`email-imap`)
- [ ] Connection creation form (IMAP/SMTP credentials)
- [ ] Connection validation (IMAP login + SMTP EHLO)
- [ ] Read operations: list folders, list messages, read message, download attachment
- [ ] Send operations: send, reply, forward
- [ ] Management: move, copy, delete, flags
- [ ] Allowlist templates and security presets
- [ ] Audit logging

### Phase 2: Polish
- [ ] Provider presets (Gmail, iCloud, Fastmail, Yahoo)
- [ ] Connection pool management (idle timeout, max connections)
- [ ] Search query parser (human-readable → IMAP SEARCH)
- [ ] Batch operations
- [ ] OpenClaw plugin reference files

### Phase 3: Advanced
- [ ] IMAP IDLE notifications (inbound email watching)
- [ ] OAuth2 XOAUTH2 for IMAP (reuse existing OAuth connections)
- [ ] POP3 support

## 11. Dependencies

| Package | Purpose | License | Already in repo? |
|---------|---------|---------|-------------------|
| imapflow | IMAP client (async, modern) | MIT | No — add |
| nodemailer | SMTP client | MIT | Yes (transactional emails) |
| mailparser | MIME parsing | MIT | No — add (or use imapflow's built-in) |

## 12. Risks

| Risk | Mitigation |
|------|------------|
| IMAP connection management (stateful TCP) | Connection pooling with idle timeout + max pool size per replica |
| Large mailboxes (100K+ messages) | Pagination with server-side IMAP SEARCH, never fetch all |
| Attachment size | Stream attachments through vault (don't buffer in memory) |
| Provider quirks (Gmail labels vs folders, Exchange extensions) | Start with standard IMAP — provider-specific extensions later |
| Connection pool across vault replicas | Each replica maintains its own pool (stateless across replicas, same as current architecture) |
