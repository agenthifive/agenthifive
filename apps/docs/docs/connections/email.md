---
sidebar_position: 14
title: Email (IMAP/SMTP)
description: Connect any email server via IMAP and SMTP for vault-managed email access
---

# Email (IMAP/SMTP)

Connect to any email server that supports IMAP and SMTP. The vault stores your email credentials, translates REST requests to IMAP/SMTP protocol commands, and applies the full policy engine (allowlists, PII redaction, rate limits, approval) to every email operation.

:::info
Unlike the [Google Gmail](/connections/google) and [Microsoft Outlook](/connections/microsoft) connections which use OAuth and provider-specific REST APIs, the Email (IMAP/SMTP) connection works with providers that support standard IMAP/SMTP authentication — such as Fastmail, iCloud (with app-specific passwords), ProtonMail Bridge, and self-hosted mail servers. For Gmail and Outlook, use the OAuth connections instead.
:::

## Connection Setup

### Dashboard

1. Navigate to **Connections** → **Add Connection**
2. Select **Email (IMAP/SMTP)**
3. Enter your email credentials:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| Email address | Yes | — | Your email address (e.g., `user@example.com`) |
| Display name | No | — | Name shown in outgoing emails |
| IMAP host | Yes | — | IMAP server hostname (e.g., `imap.gmail.com`) |
| IMAP port | No | 993 | IMAP server port |
| IMAP TLS | No | true | Use TLS encryption |
| SMTP host | Yes | — | SMTP server hostname (e.g., `smtp.gmail.com`) |
| SMTP port | No | 587 | SMTP server port |
| SMTP STARTTLS | No | true | Use STARTTLS encryption |
| Username | No | Email address | Login username (defaults to email) |
| Password | Yes | — | Email password or app password |
| Label | No | Auto | Display label for this connection |

4. AgentHiFive validates the connection by testing IMAP login and SMTP authentication
5. Click **Create** — the connection appears as "Healthy"

### API

```bash
curl -X POST https://your-vault.com/v1/connections/email \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "displayName": "User Name",
    "imapHost": "imap.example.com",
    "imapPort": 993,
    "imapTls": true,
    "smtpHost": "smtp.example.com",
    "smtpPort": 587,
    "smtpStarttls": true,
    "password": "your-app-password",
    "label": "Work Email"
  }'
```

### Common Provider Settings

| Provider | IMAP Host | SMTP Host | Notes |
|----------|-----------|-----------|-------|
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:587` | Supports app passwords |
| iCloud | `imap.mail.me.com:993` | `smtp.mail.me.com:587` | Requires [App-Specific Password](https://appleid.apple.com) |
| ProtonMail | `127.0.0.1:1143` | `127.0.0.1:1025` | Requires [ProtonMail Bridge](https://proton.me/mail/bridge) |
| Self-hosted | Your server | Your server | Dovecot, Postfix, etc. |

:::warning
**Gmail** and **Outlook/Hotmail** have disabled standard IMAP password authentication. Use the [Google Gmail](/connections/google) or [Microsoft Outlook](/connections/microsoft) OAuth connections instead.
:::

## Vault API Usage

All email operations use `POST /v1/vault/execute` with `service: "email-imap"` or `connectionId`.

### List Folders

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "GET",
  "url": "/folders"
}
```

Response:
```json
{
  "folders": [
    { "name": "INBOX", "path": "INBOX", "specialUse": "\\Inbox", "totalMessages": 142, "unseenMessages": 3 },
    { "name": "Sent", "path": "Sent", "specialUse": "\\Sent", "totalMessages": 89 },
    { "name": "Drafts", "path": "Drafts", "specialUse": "\\Drafts" },
    { "name": "Trash", "path": "Trash", "specialUse": "\\Trash" }
  ]
}
```

### List Messages

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "GET",
  "url": "/messages?folder=INBOX&limit=10&offset=0"
}
```

Search with query parameters:
```
/messages?folder=INBOX&q=from:bob@example.com subject:meeting&since=2026-04-01
```

Supported search operators: `from:`, `to:`, `subject:`, `body:`, `unseen`, `seen`, `flagged`, `has:attachment`, `since:YYYY-MM-DD`, `before:YYYY-MM-DD`.

### Read a Message

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "GET",
  "url": "/messages/12345?folder=INBOX"
}
```

Response includes `textBody`, `htmlBody`, `headers`, and `attachments` list.

### Send a Message

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "POST",
  "url": "/messages/send",
  "body": {
    "to": [{ "address": "recipient@example.com", "name": "Recipient" }],
    "subject": "Hello from the vault",
    "textBody": "This email was sent through AgentHiFive.",
    "cc": [],
    "bcc": []
  }
}
```

### Reply to a Message

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "POST",
  "url": "/messages/12345/reply?folder=INBOX",
  "body": {
    "textBody": "Thanks for your email!",
    "replyAll": false
  }
}
```

The vault auto-populates `To`, `Subject` (Re:), `In-Reply-To`, and `References` headers.

### Forward a Message

```json
{
  "model": "B",
  "connectionId": "conn_...",
  "method": "POST",
  "url": "/messages/12345/forward?folder=INBOX",
  "body": {
    "to": [{ "address": "alice@example.com" }],
    "textBody": "FYI — see below."
  }
}
```

### Move / Copy / Delete

```json
// Move
{ "method": "POST", "url": "/messages/12345/move?folder=INBOX", "body": { "destination": "Archive" } }

// Copy
{ "method": "POST", "url": "/messages/12345/copy?folder=INBOX", "body": { "destination": "Important" } }

// Delete
{ "method": "DELETE", "url": "/messages/12345?folder=INBOX" }
```

### Update Flags

```json
{
  "method": "PATCH",
  "url": "/messages/12345/flags?folder=INBOX",
  "body": {
    "add": ["\\Seen", "\\Flagged"],
    "remove": ["\\Draft"]
  }
}
```

## Credential Type

- **Type**: `email` (IMAP/SMTP credentials)
- **Execution model**: Model B only (credentials never leave the vault)
- **Connection**: Not singleton (multiple email accounts per workspace)

## Security

- Email credentials (username/password) are encrypted at rest with AES-256-GCM
- All operations go through the policy engine — allowlists, PII redaction, rate limits, and step-up approval
- IMAP connections are pooled server-side with 10-minute idle timeout
- SMTP connections are transient (created per send operation)
- The agent never sees the email password
