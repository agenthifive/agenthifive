/**
 * AgentHiFive Vault Prompt Reference — Chunked Architecture
 *
 * Provides two modes of API reference injection:
 *
 * 1. **Inline mode** (`buildApiReferencePrompt`): Assembles a single prompt
 *    string from provider sections. Used by the MCP server and simple consumers.
 *
 * 2. **Chunked file mode** (`writeReferenceFiles`): Writes a base reference
 *    file (tools, permissions, action templates) plus per-service API reference
 *    files to a state directory. The system prompt then contains a lean pointer
 *    listing available files. Used by the OpenClaw plugin for better accuracy.
 *
 * Chunked > monolithic: eval showed 89% accuracy (chunked) vs 72% (monolithic)
 * with realistic production-sized prompts. Models get overwhelmed when all
 * provider API docs are in one blob.
 */

import { join } from "node:path";
import { writeText } from "./env-paths.js";

// ---------------------------------------------------------------------------
// Provider-to-service aliasing (deduplicates docs for provider aliases)
// ---------------------------------------------------------------------------

const PROVIDER_TO_SERVICE: Record<string, string> = {
  gmail: "google",
  "google-gmail": "google",
};

// ---------------------------------------------------------------------------
// Inline Prompt Header/Footer (for simple buildApiReferencePrompt mode)
// ---------------------------------------------------------------------------

const PROMPT_HEADER = `## AgentHiFive API Reference

All external API calls go through the \`agenthifive.execute\` tool.
Authentication is handled automatically by the vault — do not add Authorization headers.

Before making API calls, use \`agenthifive.connections_list\` to discover available connections and their IDs.`;

const PROMPT_FOOTER = `### Notes
- All dates use ISO 8601 format (e.g., "2026-01-15T09:00:00Z")
- Google and Microsoft use the same connectionId for all their APIs (one OAuth connection covers mail + calendar + drive)
- If a request is blocked by policy, the error will indicate which URL patterns are allowed`;

// ---------------------------------------------------------------------------
// Inline per-provider sections (for simple buildApiReferencePrompt mode)
// ---------------------------------------------------------------------------

export const API_REFERENCE_SECTIONS: Record<string, string> = {
  google: `### Google Gmail (provider: google)

List messages:
  GET https://gmail.googleapis.com/gmail/v1/users/me/messages
  query: { q: "search query", maxResults: "10", labelIds: "INBOX" }

Get message:
  GET https://gmail.googleapis.com/gmail/v1/users/me/messages/{messageId}
  query: { format: "full" }

Send message:
  POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
  body: { raw: "<base64url-encoded RFC 2822 message>" }

Search operators: from:, to:, subject:, newer_than:1d, older_than:7d, has:attachment, is:unread

### Google Calendar (provider: google)

List events:
  GET https://www.googleapis.com/calendar/v3/calendars/primary/events
  query: { timeMin: "ISO8601", timeMax: "ISO8601", singleEvents: "true", orderBy: "startTime" }

Create event:
  POST https://www.googleapis.com/calendar/v3/calendars/primary/events
  body: { summary: "...", start: { dateTime: "ISO8601" }, end: { dateTime: "ISO8601" }, attendees: [{ email: "..." }] }

### Google Drive (provider: google)

List files:
  GET https://www.googleapis.com/drive/v3/files
  query: { q: "'root' in parents", fields: "files(id,name,mimeType,modifiedTime)", pageSize: "20" }

Get file metadata:
  GET https://www.googleapis.com/drive/v3/files/{fileId}
  query: { fields: "id,name,mimeType,size,modifiedTime,webViewLink" }`,

  notion: `### Notion (provider: notion)

⚠ Every request MUST include the Notion-Version header in the headers field:
  headers: { "Notion-Version": "2022-06-28" }
⚠ Notion uses POST for search and database queries — these are read operations despite using POST.

Search pages and databases:
  POST https://api.notion.com/v1/search
  body: { query: "search text" }

Get page:
  GET https://api.notion.com/v1/pages/{pageId}

Get page property:
  GET https://api.notion.com/v1/pages/{pageId}/properties/{propertyId}

Get database:
  GET https://api.notion.com/v1/databases/{databaseId}

Query database:
  POST https://api.notion.com/v1/databases/{databaseId}/query
  body: { filter: { property: "Status", select: { equals: "Active" } }, sorts: [{ property: "Date", direction: "descending" }] }

List block children:
  GET https://api.notion.com/v1/blocks/{blockId}/children

Create page:
  POST https://api.notion.com/v1/pages
  body: { parent: { database_id: "..." }, properties: { Name: { title: [{ text: { content: "..." } }] } } }

Update page:
  PATCH https://api.notion.com/v1/pages/{pageId}
  body: { properties: { Status: { select: { name: "Done" } } } }

Append blocks to page:
  PATCH https://api.notion.com/v1/blocks/{blockId}/children
  body: { children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: "..." } }] } }] }

List comments:
  GET https://api.notion.com/v1/comments
  query: { block_id: "..." }

Create comment:
  POST https://api.notion.com/v1/comments
  body: { parent: { page_id: "..." }, rich_text: [{ text: { content: "..." } }] }`,

  microsoft: `### Microsoft Graph — Mail (provider: microsoft)

List messages:
  GET https://graph.microsoft.com/v1.0/me/messages
  query: { "$top": "10", "$orderby": "receivedDateTime desc", "$select": "subject,from,receivedDateTime,bodyPreview" }

Send mail:
  POST https://graph.microsoft.com/v1.0/me/sendMail
  body: { message: { subject: "...", body: { contentType: "Text", content: "..." }, toRecipients: [{ emailAddress: { address: "..." } }] } }

### Microsoft Graph — Calendar (provider: microsoft)

List events:
  GET https://graph.microsoft.com/v1.0/me/calendarView
  query: { startDateTime: "ISO8601", endDateTime: "ISO8601", "$select": "subject,start,end,location,organizer" }

### Microsoft Graph — Files (provider: microsoft)

List files:
  GET https://graph.microsoft.com/v1.0/me/drive/root/children
  query: { "$select": "id,name,size,lastModifiedDateTime,webUrl" }`,
};

// ===========================================================================
// CHUNKED FILE MODE (for OpenClaw plugin)
// ===========================================================================

// ---------------------------------------------------------------------------
// Base reference sections (no provider API docs — those go in per-service files)
// ---------------------------------------------------------------------------

const SECTION_HEADER = `# AgentHiFive Vault Reference

This file is auto-generated at startup. It describes how to use the AgentHiFive vault
to access external services (email, calendar, files, messaging).

Authentication is handled automatically by the vault — never add Authorization headers yourself.`;

const SECTION_TOOLS = `## Available Tools

| Tool | Purpose |
|------|---------|
| \`request_permission\` | Request access to a service (workspace owner approves in dashboard) |
| \`vault_execute\` | Make an API call through the vault proxy — vault injects credentials, enforces policies, logs audit |
| \`vault_download\` | Download a file through the vault and save to disk — returns local file path. Use for binary downloads (Drive files, attachments, images) |
| \`vault_connections_list\` | List active connections (service name, label, status) |
| \`vault_await_approval\` | (Fallback) Block until a step-up approval resolves. Only use if the user explicitly asks you to wait — the system auto-notifies you by default |
| \`list_approvals\` | Check status of step-up approval requests (pending, approved, denied, expired, consumed) |`;

const SECTION_PERMISSION_FLOW = `## How It Works

1. **Request access:** Call \`request_permission\` with:
   - \`actionTemplateId\`: the capability ID (see table below)
   - \`reason\`: why you need it (e.g., "User asked me to send a Telegram message")
2. **Tell the user** you've requested access and they need to approve it in the AgentHiFive dashboard
3. **After approval, make API calls:** Call \`vault_execute\` with:
   - \`service\`: the service name (e.g., \`"telegram"\`, \`"anthropic-messages"\`, \`"gmail"\`)
   - \`method\`: HTTP method (GET, POST, PUT, DELETE, PATCH)
   - \`url\`: the provider API URL (see API Reference below)
   - \`body\`: request body (for POST/PUT/PATCH)
   - For multi-account services (Google, Microsoft), also pass \`connectionId\` from \`vault_connections_list\`

### Step-Up Approvals

Some actions require per-request approval (e.g., downloading files, sending emails in strict mode).
When \`vault_execute\` returns \`approvalRequired: true\` (HTTP 202):

1. **Note the \`approvalRequestId\`** from the response
2. **Tell the user** this specific action needs approval in the AgentHiFive dashboard
3. **Do NOT call \`vault_await_approval\`** — the system will automatically notify you when the approval resolves. You will receive an approval notification with the approvalId when the user approves (or a denial/expiry notice).
4. **When you receive the notification**, re-submit the **exact same request** with \`approvalId\` set to the \`approvalRequestId\`:
   \`vault_execute({ ...sameParams, approvalId: "the-approval-id" })\`
5. **If denied or expired**, inform the user and do not retry.

The approval is single-use: once consumed by a successful re-submit, it cannot be reused.

**Important:** Never add Authorization headers — the vault injects credentials automatically.
Never modify \`credentials.vault.connections\` in openclaw.json — the vault resolves connections automatically by service name.`;

const SECTION_ACTION_TEMPLATES = `## Action Template IDs

| ID | Service | Description |
|----|---------|-------------|
| \`gmail-read\` | Google Gmail | Read messages and search |
| \`gmail-manage\` | Google Gmail | Read, send, compose drafts, manage labels |
| \`calendar-read\` | Google Calendar | Read events |
| \`calendar-manage\` | Google Calendar | Read, create, edit, delete events |
| \`drive-read\` | Google Drive | Read files |
| \`drive-manage\` | Google Drive | Read, upload, edit, delete files |
| \`docs-read\` | Google Docs | Read documents |
| \`docs-manage\` | Google Docs | Read, create, edit documents |
| \`sheets-read\` | Google Sheets | Read spreadsheets |
| \`sheets-manage\` | Google Sheets | Read, create, edit spreadsheets |
| \`contacts-read\` | Google Contacts | Read contacts and contact groups |
| \`contacts-manage\` | Google Contacts | Read, create, edit, delete contacts |
| \`outlook-read\` | Microsoft Outlook | Read mail |
| \`outlook-manage\` | Microsoft Outlook | Read, send, manage emails |
| \`outlook-calendar-read\` | Outlook Calendar | Read events |
| \`outlook-calendar-manage\` | Outlook Calendar | Read, create, edit, delete events |
| \`outlook-contacts-read\` | Outlook Contacts | Read contacts |
| \`outlook-contacts-manage\` | Outlook Contacts | Read, create, edit, delete contacts |
| \`onedrive-read\` | OneDrive | Read files |
| \`onedrive-manage\` | OneDrive | Read, upload, edit, delete files |
| \`slack\` | Slack | Read/send messages, upload files, manage reactions |
| \`telegram\` | Telegram | Send/receive messages via bot |
| \`anthropic-messages\` | Anthropic | Claude LLM API |
| \`openai\` | OpenAI | Chat completions, embeddings, model listing |
| \`gemini\` | Google Gemini | Content generation, embeddings, model listing |
| \`openrouter\` | OpenRouter | Chat completions and model listing |
| \`notion-read\` | Notion | Read pages, databases, blocks, and search |
| \`notion-manage\` | Notion | Read, create, update pages and databases |
| \`trello-read\` | Trello | Read boards, lists, cards, and labels |
| \`trello-manage\` | Trello | Read, create, update cards and lists |
| \`jira-read\` | Jira | Search and read issues, projects, and comments |
| \`jira-manage\` | Jira | Read, create, update issues and comments |`;

const SECTION_NOTES = `## CRITICAL — Vault-Managed Channels

**STOP — If the AgentHiFive vault plugin is active, channel config should live under \`channels.agenthifive\`. Do NOT add or "fix" native \`channels.telegram\` or \`channels.slack\` sections, and do not add native bot tokens or Socket Mode settings.**

**Microsoft Teams is not currently part of the AgentHiFive OpenClaw channel surface. Do not route Teams chat/message work through the generic Microsoft Graph tool recipe below, and do not tell users to configure Teams channels in this build.**

When a user asks to enable a NEW channel (one not yet in config), use \`config.patch\` with the exact AgentHiFive account shape below.

### Enabling Slack
\`\`\`json
{
  "channels": {
    "agenthifive": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "https://vault.example.com",
          "auth": { "mode": "agent", "agentId": "ag_...", "privateKey": "<base64-jwk>" },
          "providers": {
            "slack": { "enabled": true }
          }
        }
      }
    }
  }
}
\`\`\`

### Enabling Telegram
\`\`\`json
{
  "channels": {
    "agenthifive": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "https://vault.example.com",
          "auth": { "mode": "agent", "agentId": "ag_...", "privateKey": "<base64-jwk>" },
          "providers": {
            "telegram": { "enabled": true, "dmPolicy": "balanced", "allowFrom": [] }
          }
        }
      }
    }
  }
}
\`\`\`

### DO NOT — Channel Configuration
- Do NOT add native \`channels.telegram\` or \`channels.slack\` sections when using AgentHiFive
- Do NOT add \`mode: "socket"\` or \`mode: "http"\`
- Do NOT add \`webhookPath\`, \`signingSecret\`, \`appToken\`, \`botToken\`, \`groupPolicy\`, \`streaming\`, \`nativeStreaming\`, or \`userTokenReadOnly\`
- Do NOT ask users for bot tokens, app tokens, API keys, or channel credentials
- Do NOT hand-build Telegram or Slack sends with \`vault_execute\` when you are already in a vault-managed channel conversation — use the native channel reply/send flow
- Do NOT configure \`plugins.entries.slack\` or \`plugins.entries.telegram\` — only the \`channels.agenthifive\` block is needed for vault-managed channels
- Do NOT modify \`credentials.vault.connections\` in openclaw.json — the vault resolves connections automatically

### After enabling
After the config is written and the gateway loads the AgentHiFive account, inbound delivery and approvals are handled by the AgentHiFive channel plugin.

### Disabling a channel
Disable the provider under \`channels.agenthifive.accounts.<accountId>.providers.<name>\` or remove it from that account block.

### Auto-polling
When a channel is enabled and the vault has an active connection, incoming messages are automatically polled and dispatched to you. You do NOT need to call \`getUpdates\`, \`conversations.history\`, or any other polling API yourself.

## Notes

- **No connection UUIDs for singletons:** Telegram, Slack, Anthropic, OpenAI, Gemini, and OpenRouter are singletons (one connection per workspace). Always use \`service: "telegram"\`, \`service: "slack"\`, \`service: "anthropic-messages"\`, \`service: "openai"\`, \`service: "gemini"\`, or \`service: "openrouter"\` — never use a connection UUID for these.
- Multi-account services (Google, Microsoft) may have multiple connections — use \`connectionId\` from \`vault_connections_list\` only for these.
- All dates use ISO 8601 format (e.g., "2026-01-15T09:00:00Z")

## Retry & Failure Rules

- **Never retry the same \`vault_execute\` call more than once.** If the same call fails twice (original + 1 retry), stop and explain the error to the user. Do NOT keep trying.
- **Empty or missing response body:** If a \`vault_execute\` call returns an empty body, no data, or times out, treat it as a definitive failure. Do NOT retry. Report the issue to the user immediately.
- **Binary file downloads:** \`vault_execute\` cannot return binary data — it returns a \`_binaryContent\` metadata object instead. Before downloading any file, check its content type or mimeType. Prefer structured API access (JSON) over binary downloads whenever possible. When binary is unavoidable, use \`vault_download\` — it saves the file to disk and returns the local file path.
- **Large responses saved to disk:** When a \`vault_execute\` response exceeds ~50KB (e.g., JSON with embedded base64 attachments), the full JSON is automatically saved to disk. The result includes \`responseSavedToDisk: true\`, \`path\` (local file), \`preview\` (structural summary), and \`hint\`. Read the file with your file tools to access specific fields. This prevents large payloads from filling your context window.

## Error Handling

When the vault blocks a request, the response includes an \`error\` field and often a \`hint\` field. **Always read the hint** — it tells you exactly how to fix your request:
- **Wrong HTTP method:** hint lists the allowed methods (e.g., "Allowed methods: POST" — common with Slack)
- **Wrong URL path:** hint lists allowed path patterns
- **Wrong host:** hint lists which hosts have allowlist rules
- **Rate limited:** hint tells you when to retry (\`retryAfter\` seconds)
- **Model mismatch:** hint tells you which execution model to use instead
- **No permission:** call \`request_permission\` to request the needed capability
- **Step-up required (202):** hint tells you to re-submit with \`approvalId\` after user approval
- **Download blocked by approval:** If \`vault_download\` returns a step-up approval (202), tell the user their options:
  1. Approve the download in the AgentHiFive dashboard (you'll retry with the \`approvalId\`)
  2. If the file is a convertible type (documents, spreadsheets, PDFs, presentations), you can try the copy-convert approach instead — it reads content through structured APIs without a binary download, which may not require the same approval`;

// ---------------------------------------------------------------------------
// Per-provider API sections (chunked — one file per service group)
// ---------------------------------------------------------------------------

export const CHUNKED_API_SECTIONS: Record<string, string> = {
  google: `### Google APIs (provider: google, multi-account — use connectionId)

Google APIs use standard REST: GET for reads, POST for writes. Use \`connectionId\` from \`vault_connections_list\`.

**Gmail** (base: \`https://gmail.googleapis.com\`):
- List messages: \`GET /gmail/v1/users/me/messages\` — query: \`{ q, maxResults, labelIds }\`
- Get message: \`GET /gmail/v1/users/me/messages/{id}\` — query: \`{ format: "full" }\`
- Get attachment: \`GET /gmail/v1/users/me/messages/{id}/attachments/{attachmentId}\`
- List labels: \`GET /gmail/v1/users/me/labels\`
- Send message: \`POST /gmail/v1/users/me/messages/send\` — body: \`{ raw: "<base64url-encoded RFC 2822 email>" }\`
  ⚠ The \`raw\` field must be a base64url-encoded string of a complete RFC 2822 email (with To, Subject, MIME headers).
- Search operators: \`from:\`, \`to:\`, \`subject:\`, \`newer_than:1d\`, \`has:attachment\`, \`is:unread\`
- Policy notes (vary by user's security tier — vault returns a hint if a rule blocks you):
  - **Strict read**: only messages with \`newer_than:Xd\` (1–7 days) in the query are allowed without approval; always include a recency filter
  - **Balanced read/manage**: attachment requests (\`/attachments/\`) require the user's approval
  - **Strict manage**: same read constraints apply; sends and drafts also require approval; deletions are blocked

**Calendar** (base: \`https://www.googleapis.com\`):
- List events: \`GET /calendar/v3/calendars/primary/events\` — query: \`{ timeMin, timeMax, singleEvents, orderBy }\`
- Create event: \`POST /calendar/v3/calendars/primary/events\` — body: \`{ summary, start, end, attendees }\`
- Policy notes:
  - **Strict read**: listing events is allowed; reading individual event details requires approval
  - **Strict manage**: same read constraints; event creation/modification requires approval; deletion is blocked
  - **Balanced**: all reads allowed; writes allowed within rate limits

**Drive** (base: \`https://www.googleapis.com\`):
- List files: \`GET /drive/v3/files\` — query: \`{ q, fields, pageSize }\`
- Get file metadata: \`GET /drive/v3/files/{id}\` — query: \`{ fields: "id,name,mimeType,size,webViewLink" }\`
- Export Google-native file: \`GET /drive/v3/files/{id}/export\` — query: \`{ mimeType: "text/csv" }\` (or \`text/plain\`, \`application/pdf\`)
- Copy file: \`POST /drive/v3/files/{id}/copy\` — body: \`{ mimeType: "application/vnd.google-apps.spreadsheet" }\`
- Download binary file: \`vault_download({ url: "https://www.googleapis.com/drive/v3/files/{id}?alt=media", connectionId: "..." })\`
- Policy notes:
  - **Strict**: binary downloads (\`alt=media\`) are blocked; use copy-convert or export instead. File listing is allowed; metadata reads require approval
  - **Balanced**: binary downloads require approval; all reads allowed; writes allowed within rate limits
  - **Minimal**: all operations allowed within rate limits

**Reading file contents — decision tree:**
1. Get file metadata first (\`GET /drive/v3/files/{id}?fields=mimeType,name\`)
2. **Google-native file** (\`application/vnd.google-apps.*\`):
   - Spreadsheet → use Sheets API via \`vault_execute\` (returns structured JSON)
   - Document → use Docs API via \`vault_execute\` (returns structured JSON)
   - Or export: \`GET /drive/v3/files/{id}/export?mimeType=text/csv\` via \`vault_execute\`
3. **Convertible file** — copy-convert to a Google-native format, then read via structured API:
   - \`POST /drive/v3/files/{id}/copy\` with body \`{ mimeType: "<target>" }\`
   - Read the converted copy via the appropriate API (\`vault_execute\`), then delete the copy
   - Target mimeType by source:
     - \`.xls\`, \`.xlsx\`, \`.csv\`, \`.ods\` → \`application/vnd.google-apps.spreadsheet\` → read via Sheets API
     - \`.docx\`, \`.doc\`, \`.rtf\`, \`.odt\`, \`.html\`, \`.txt\` → \`application/vnd.google-apps.document\` → read via Docs API
     - \`.pptx\`, \`.ppt\`, \`.odp\` → \`application/vnd.google-apps.presentation\` → export as \`text/plain\`
     - PDF → \`application/vnd.google-apps.document\` (OCR) → read via Docs API or export as \`text/plain\`
     - Images (when extracting text) → \`application/vnd.google-apps.document\` (OCR)
   - Prefer this over \`vault_download\` whenever you need text content — it avoids binary transfer entirely
   - OCR quality varies: works well for text-heavy PDFs/images, poorly for scans or complex layouts
4. **Non-convertible binary** (audio, video, archives, proprietary formats) → use \`vault_download\`
5. **Never** use \`vault_execute\` with \`alt=media\` — binary data cannot pass through JSON serialization

**Docs** (base: \`https://docs.googleapis.com\`):
- Get document: \`GET /v1/documents/{documentId}\`
- Create document: \`POST /v1/documents\` — body: \`{ title: "..." }\`
- Batch update: \`POST /v1/documents/{documentId}:batchUpdate\` — body: \`{ requests: [...] }\`
  Common requests: \`insertText\` (\`{ location: { index }, text }\`), \`deleteContentRange\` (\`{ range: { startIndex, endIndex } }\`), \`replaceAllText\` (\`{ containsText: { text, matchCase }, replaceText }\`)

**Sheets** (base: \`https://sheets.googleapis.com\`):
- Get spreadsheet: \`GET /v4/spreadsheets/{spreadsheetId}\` — query: \`{ ranges, includeGridData }\`
- Read values: \`GET /v4/spreadsheets/{spreadsheetId}/values/{range}\` — range format: \`Sheet1!A1:D10\`
- Update values: \`PUT /v4/spreadsheets/{spreadsheetId}/values/{range}\` — query: \`{ valueInputOption: "USER_ENTERED" }\` — body: \`{ values: [[...]] }\`
- Append rows: \`POST /v4/spreadsheets/{spreadsheetId}/values/{range}:append\` — query: \`{ valueInputOption: "USER_ENTERED" }\` — body: \`{ values: [[...]] }\`
- Create spreadsheet: \`POST /v4/spreadsheets\` — body: \`{ properties: { title: "..." } }\`

**Contacts** (base: \`https://people.googleapis.com\`):
- List contacts: \`GET /v1/people/me/connections\` — query: \`{ personFields: "names,emailAddresses,phoneNumbers", pageSize: 100 }\`
- Get contact: \`GET /v1/people/{resourceName}\` — query: \`{ personFields: "names,emailAddresses,phoneNumbers,addresses,organizations" }\`
  - resourceName format: \`people/c1234567890\`
- Search contacts: \`GET /v1/people:searchContacts\` — query: \`{ query: "search term", readMask: "names,emailAddresses" }\`
- Create contact: \`POST /v1/people:createContact\` — body: \`{ names: [{ givenName, familyName }], emailAddresses: [{ value }], phoneNumbers: [{ value }] }\`
- Update contact: \`PATCH /v1/people/{resourceName}:updateContact\` — query: \`{ updatePersonFields: "names,emailAddresses" }\` — body: same as create
- Delete contact: \`DELETE /v1/people/{resourceName}:deleteContact\`
- List contact groups: \`GET /v1/contactGroups\`
- ⚠ Always include \`personFields\` (for get/list) or \`readMask\` (for search) — the API returns no data without it
- Policy notes:
  - **Minimal**: notes/biographies stripped, all other fields visible
  - **Balanced**: PII fields (phone numbers, addresses, birthdays) stripped by default. To access full fields for a **specific contact**, add \`requestFullFields: true\` to vault_execute — this triggers step-up approval. Only works on individual contact endpoints (e.g. \`GET /v1/people/c1234567890\`), NOT on list or search endpoints. Once approved, re-submit with both \`approvalId\` and \`requestFullFields: true\`. Notes remain stripped even with approval.
  - **Strict**: PII fields always stripped, no way to request them. Deletion is blocked on manage connections.`,

  gmail: ``, // covered by "google"

  microsoft: `### Microsoft Graph APIs (provider: microsoft, multi-account — use connectionId)

Microsoft Graph uses standard REST: GET for reads, POST for writes. Use \`connectionId\` from \`vault_connections_list\`.
Base URL: \`https://graph.microsoft.com/v1.0\`
⚠ Query parameters use OData syntax with \`$\` prefix: \`$top\`, \`$select\`, \`$orderby\`, \`$filter\`.

**Mail:**
- List messages: \`GET /me/messages\` — query: \`{ $top, $orderby, $select }\`
- Send mail: \`POST /me/sendMail\` — body: \`{ message: { subject, body: { contentType, content }, toRecipients: [{ emailAddress: { address } }] } }\`
- Policy notes:
  - **Strict read**: listing messages is allowed; reading message body/attachments requires approval
  - **Strict manage**: same read constraints; sending mail requires approval; deletion is blocked
  - **Balanced**: all reads allowed; attachment downloads require approval

**Calendar:**
- List events: \`GET /me/calendarView\` — query: \`{ startDateTime, endDateTime, $select }\`
- Create event: \`POST /me/events\` — body: \`{ subject, start, end, attendees }\`
- Policy notes:
  - **Strict read**: listing events is allowed; reading individual event details requires approval
  - **Strict manage**: same read constraints; event creation/modification requires approval; deletion is blocked
  - **Balanced**: all reads allowed; writes allowed within rate limits

**Contacts:**
- List contacts: \`GET /me/contacts\` — query: \`{ $top, $select, $orderby }\`
- Get contact: \`GET /me/contacts/{contactId}\`
- Search people: \`GET /me/people\` — query: \`{ $search: "name", $top }\`
- Create contact: \`POST /me/contacts\` — body: \`{ givenName, surname, emailAddresses: [{ address, name }], businessPhones: ["..."] }\`
- Update contact: \`PATCH /me/contacts/{contactId}\` — body: updated fields
- Delete contact: \`DELETE /me/contacts/{contactId}\`
- List contact folders: \`GET /me/contactFolders\`
- Policy notes:
  - **Minimal**: notes stripped, all other fields visible
  - **Balanced**: PII fields (phone numbers, addresses, birthdays) stripped by default. To access full fields for a **specific contact**, add \`requestFullFields: true\` to vault_execute — only works on individual contact endpoints (e.g. \`GET /v1.0/me/contacts/{id}\`), NOT on list endpoints. Once approved, re-submit with both \`approvalId\` and \`requestFullFields: true\`. Notes remain stripped.
  - **Strict**: PII fields always stripped, no way to request them. Deletion is blocked on manage connections.

**Files (OneDrive):**
- List root files: \`GET /me/drive/root/children\` — query: \`{ $select, $top, $orderby }\`
- List folder contents: \`GET /me/drive/items/{itemId}/children\`
- Get file metadata: \`GET /me/drive/items/{itemId}\` — query: \`{ $select: "id,name,file,size,webUrl" }\`
- Search files: \`GET /me/drive/root/search(q='{query}')\`
- Upload small file (<4MB): \`PUT /me/drive/root:/{path}:/content\` — body: file bytes, header: \`Content-Type: application/octet-stream\`
- Create folder: \`POST /me/drive/root/children\` — body: \`{ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }\`
- Delete item: \`DELETE /me/drive/items/{itemId}\`
- Move/rename: \`PATCH /me/drive/items/{itemId}\` — body: \`{ name, parentReference: { id } }\`
- Create sharing link: \`POST /me/drive/items/{itemId}/createLink\` — body: \`{ type: "view"|"edit", scope: "organization"|"anonymous" }\`
- Invite collaborator: \`POST /me/drive/items/{itemId}/invite\` — body: \`{ recipients: [{ email }], roles: ["read"|"write"] }\`

**Excel Workbook API** (read spreadsheet content as structured JSON — no binary download):
- List worksheets: \`GET /me/drive/items/{itemId}/workbook/worksheets\`
- Read used range: \`GET /me/drive/items/{itemId}/workbook/worksheets/{sheetName}/usedRange\` — returns \`{ values: [[...]] }\`
- Read specific range: \`GET /me/drive/items/{itemId}/workbook/worksheets/{sheetName}/range(address='A1:Z100')\`
- Update cells: \`PATCH /me/drive/items/{itemId}/workbook/worksheets/{sheetName}/range(address='A1:B2')\` — body: \`{ values: [["a","b"],["c","d"]] }\`
- Add rows: \`POST /me/drive/items/{itemId}/workbook/tables/{tableId}/rows\` — body: \`{ values: [["a","b"]] }\`

**Reading OneDrive file contents — decision tree:**
1. Get file metadata first: \`GET /me/drive/items/{id}?$select=name,file,size\` — check \`file.mimeType\`
2. **Excel files** (\`.xlsx\`, \`.xls\`, \`.csv\` opened in Excel) → Use the Excel Workbook API above via \`vault_execute\` — returns structured JSON with cell values, no binary download needed
3. **Text files** (\`.txt\`, \`.csv\`, \`.json\`, \`.md\`, \`.log\`, \`.xml\`, \`.html\`) → \`vault_download\` to save to disk, then read the local file
4. **Other binary files** (images, PDFs, \`.docx\`, \`.pptx\`, audio, video) → \`vault_download\`
5. **Never** use \`vault_execute\` with \`/content\` — the \`/content\` endpoint returns binary data via a redirect to SharePoint, which cannot pass through JSON serialization. You will get a \`_binaryContent\` metadata response instead of actual file content.
6. **Do NOT use Google APIs** (Sheets, Docs, Drive) to read OneDrive files — they are different providers.

- Policy notes (OneDrive):
  - **Strict**: binary downloads (\`/content\`) are blocked; use the Excel Workbook API for spreadsheets. File listing is allowed; metadata reads require approval
  - **Balanced**: binary downloads require approval; all reads allowed; writes allowed within rate limits
  - **Minimal**: all operations allowed within rate limits`,

  slack: `### Slack API (provider: slack, singleton)

**⚠ ALL Slack API methods use POST — never use GET.** This is not standard REST. Even read operations
(conversations.history, users.info) require POST with parameters in the JSON body, not query strings.

Use \`service: "slack"\` with \`vault_execute\`. The vault injects the bot token as a Bearer header automatically.

**Read operations (all POST):**
- Read messages: \`POST https://slack.com/api/conversations.history\` — body: \`{ channel, limit }\`
- Read thread: \`POST https://slack.com/api/conversations.replies\` — body: \`{ channel, ts }\`
- List channels: \`POST https://slack.com/api/conversations.list\` — body: \`{ types, limit }\`
- Get user info: \`POST https://slack.com/api/users.info\` — body: \`{ user }\`
- List emoji: \`POST https://slack.com/api/emoji.list\`
- List pins: \`POST https://slack.com/api/pins.list\` — body: \`{ channel }\`

**Write operations (all POST):**
- Send message: \`POST https://slack.com/api/chat.postMessage\` — body: \`{ channel, text, blocks }\`
- Update message: \`POST https://slack.com/api/chat.update\` — body: \`{ channel, ts, text }\`
- Delete message: \`POST https://slack.com/api/chat.delete\` — body: \`{ channel, ts }\`
- Upload file: \`POST https://slack.com/api/files.uploadV2\` — body: \`{ channel_id, content, filename }\`
- Add reaction: \`POST https://slack.com/api/reactions.add\` — body: \`{ channel, timestamp, name }\`

Wrong: \`GET https://slack.com/api/conversations.history?channel=C123&limit=10\`
Right: \`POST https://slack.com/api/conversations.history\` with body \`{ "channel": "C123", "limit": 10 }\``,

  telegram: `### Telegram Bot API (provider: telegram, singleton)

**Channel-runtime first:** If you are already handling a live Telegram conversation through the AgentHiFive channel plugin, reply with the native channel send/reply flow instead of calling \`vault_execute\`.

**URL format:** \`https://api.telegram.org/bot/<method>\` — the vault injects the real bot token automatically when you do need a direct API call.
Do NOT put a token or placeholder in the URL (NOT \`/bot{token}/sendMessage\`, NOT \`/bot123:ABC/sendMessage\`).

**Write operations (POST):**
- Send message: \`POST https://api.telegram.org/bot/sendMessage\` — body: \`{ chat_id, text, parse_mode }\`
- Send photo: \`POST https://api.telegram.org/bot/sendPhoto\` — body: \`{ chat_id, photo }\`
- Forward message: \`POST https://api.telegram.org/bot/forwardMessage\` — body: \`{ chat_id, from_chat_id, message_id }\`

**Read operations (GET):**
- Get updates: \`GET https://api.telegram.org/bot/getUpdates\` — query: \`{ offset, timeout }\`
- Get chat: \`GET https://api.telegram.org/bot/getChat\` — query: \`{ chat_id }\`

Use \`service: "telegram"\` with \`vault_execute\` only for direct Telegram API operations outside the normal channel reply flow. Never use a connectionId for Telegram.
Incoming messages are auto-polled — you do NOT need to call getUpdates yourself.`,

  notion: `### Notion API (provider: notion, multi-account — use connectionId)

**Base URL:** \`https://api.notion.com\`
⚠ **Every request MUST include the \`Notion-Version\` header.** Pass it in the \`headers\` field:
\`headers: { "Notion-Version": "2022-06-28" }\`

⚠ **Notion uses POST for some read operations** (search, database queries). These are NOT writes — they just happen to use POST.

Use \`connectionId\` from \`vault_connections_list\`. Notion is NOT a singleton — each user authorizes their own workspace.

**Read operations:**
- Search pages & databases: \`POST https://api.notion.com/v1/search\` — body: \`{ query: "search text" }\`
- Get page: \`GET https://api.notion.com/v1/pages/{page_id}\`
- Get page property: \`GET https://api.notion.com/v1/pages/{page_id}/properties/{property_id}\`
- Get database: \`GET https://api.notion.com/v1/databases/{database_id}\`
- Query database: \`POST https://api.notion.com/v1/databases/{database_id}/query\` — body: \`{ filter: {...}, sorts: [...] }\`
- Get block: \`GET https://api.notion.com/v1/blocks/{block_id}\`
- List block children: \`GET https://api.notion.com/v1/blocks/{block_id}/children\`
- List comments: \`GET https://api.notion.com/v1/comments\` — query: \`{ block_id }\`
- List users: \`GET https://api.notion.com/v1/users\`

**Write operations:**
- Create page: \`POST https://api.notion.com/v1/pages\` — body: \`{ parent: { database_id: "..." }, properties: {...} }\`
- Update page: \`PATCH https://api.notion.com/v1/pages/{page_id}\` — body: \`{ properties: {...} }\`
- Update block: \`PATCH https://api.notion.com/v1/blocks/{block_id}\` — body: \`{ type: {...} }\`
- Append blocks: \`PATCH https://api.notion.com/v1/blocks/{block_id}/children\` — body: \`{ children: [...] }\`
- Delete block: \`DELETE https://api.notion.com/v1/blocks/{block_id}\`
- Create comment: \`POST https://api.notion.com/v1/comments\` — body: \`{ parent: { page_id: "..." }, rich_text: [...] }\`

**Common property formats:**
- Title: \`{ title: [{ text: { content: "..." } }] }\`
- Rich text: \`{ rich_text: [{ text: { content: "..." } }] }\`
- Select: \`{ select: { name: "Option" } }\`
- Date: \`{ date: { start: "2026-01-15" } }\`
- Checkbox: \`{ checkbox: true }\``,

  trello: `### Trello API (provider: trello, multi-account — use connectionId)

**Base URL:** \`https://api.trello.com\`
⚠ **Do NOT include \`key\` or \`token\` query parameters** — the vault injects both automatically.

Use \`connectionId\` from \`vault_connections_list\`. Trello is NOT a singleton — each user connects their own account.

**Read operations (GET):**
- List boards: \`GET https://api.trello.com/1/members/me/boards\`
- Get board: \`GET https://api.trello.com/1/boards/{boardId}\`
- Board lists: \`GET https://api.trello.com/1/boards/{boardId}/lists\`
- Board cards: \`GET https://api.trello.com/1/boards/{boardId}/cards\`
- Board labels: \`GET https://api.trello.com/1/boards/{boardId}/labels\`
- Get list: \`GET https://api.trello.com/1/lists/{listId}\`
- List cards: \`GET https://api.trello.com/1/lists/{listId}/cards\`
- Get card: \`GET https://api.trello.com/1/cards/{cardId}\`
- Card activity: \`GET https://api.trello.com/1/cards/{cardId}/actions\`
- Card attachments: \`GET https://api.trello.com/1/cards/{cardId}/attachments\`
- Card checklists: \`GET https://api.trello.com/1/cards/{cardId}/checklists\`

**Write operations:**
- Create card: \`POST https://api.trello.com/1/cards\` — body: \`{ name, idList, desc }\`
- Update card: \`PUT https://api.trello.com/1/cards/{cardId}\` — body: \`{ name, desc, closed, idList }\`
- Delete card: \`DELETE https://api.trello.com/1/cards/{cardId}\`
- Archive card: \`PUT https://api.trello.com/1/cards/{cardId}\` — body: \`{ closed: true }\`
- Add comment: \`POST https://api.trello.com/1/cards/{cardId}/actions/comments\` — body: \`{ text }\`
- Create list: \`POST https://api.trello.com/1/lists\` — body: \`{ name, idBoard }\`
- Update list: \`PUT https://api.trello.com/1/lists/{listId}\` — body: \`{ name }\``,

  jira: `### Jira Cloud REST API v3

Base URL: \`https://{siteUrl}/rest/api/3/\` (use the site URL from your connection)

**Read operations:**
- \`GET /rest/api/3/myself\` — current user info
- \`GET /rest/api/3/search/jql?jql={query}\` — search issues with JQL (preferred)
- \`GET /rest/api/3/search?jql={query}\` — search issues (deprecated, use search/jql instead)
- \`GET /rest/api/3/issue/{issueIdOrKey}\` — get issue details
- \`GET /rest/api/3/issue/{issueIdOrKey}/comment\` — get issue comments
- \`GET /rest/api/3/project\` — list projects
- \`GET /rest/api/3/project/{projectIdOrKey}\` — get project details

**Write operations:**
- \`POST /rest/api/3/issue\` — create issue (body: \`{"fields":{"project":{"key":"PROJ"},"summary":"...","issuetype":{"name":"Task"}}}\`)
- \`PUT /rest/api/3/issue/{issueIdOrKey}\` — update issue fields
- \`POST /rest/api/3/issue/{issueIdOrKey}/comment\` — add comment (body: \`{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"..."}]}]}}\`)
- \`POST /rest/api/3/issue/{issueIdOrKey}/transitions\` — transition issue (body: \`{"transition":{"id":"..."}}\`)
- \`DELETE /rest/api/3/issue/{issueIdOrKey}\` — delete issue

> Do NOT include Authorization headers; the vault injects Basic auth credentials automatically.
> Always use the full URL including your Jira site domain.`,
};

// ---------------------------------------------------------------------------
// Chunked file writing
// ---------------------------------------------------------------------------

/**
 * Write chunked reference files to a state directory.
 *
 * - Base file (vault-reference.md): tools, permission flow, action templates, notes
 * - Per-service files (vault-ref-{service}.md): API docs for each provider
 *
 * Returns the paths so the system prompt can list them.
 */
export function writeReferenceFiles(
  stateDir: string,
  logger?: { info?: (...args: unknown[]) => void },
): {
  basePath: string;
  serviceFiles: string[];
} {
  // 1. Write base reference (no provider API docs)
  const basePath = join(stateDir, "vault-reference.md");
  const baseContent = [
    SECTION_HEADER,
    SECTION_TOOLS,
    SECTION_PERMISSION_FLOW,
    SECTION_ACTION_TEMPLATES,
    SECTION_NOTES,
  ].join("\n\n");
  writeText(basePath, baseContent);
  // base reference written silently

  // 2. Write ALL per-service API reference files.
  const serviceFiles: string[] = [];
  const seen = new Set<string>();

  for (const [provider, section] of Object.entries(CHUNKED_API_SECTIONS)) {
    if (!section || seen.has(section)) {
      continue;
    }
    seen.add(section);

    const serviceName = PROVIDER_TO_SERVICE[provider] ?? provider;
    const filePath = join(stateDir, `vault-ref-${serviceName}.md`);
    writeText(filePath, section);
    serviceFiles.push(filePath);
    // service reference written silently
  }

  return { basePath, serviceFiles };
}

/**
 * Build the lean system prompt that points to the chunked reference files.
 * Injected via the before_agent_start / before_prompt_build hook.
 */
export function buildChunkedPrompt(basePath: string, serviceFiles: string[]): string {
  const instructions = [
    `You have AgentHiFive vault integration for external services (email, calendar, files, messaging).`,
    `For non-channel vault-managed services, use vault_execute. For vault-managed channel conversations, prefer the native channel reply/send flow provided by OpenClaw instead of hand-building Telegram or Slack API calls. Never ask for credentials or tokens directly.`,
    `Base reference (tools, permissions, action templates): ${basePath}`,
    ...(serviceFiles.length > 0
      ? [
          `Service API docs (read the relevant file before making vault_execute calls):`,
          ...serviceFiles.map((f) => `  - ${f}`),
        ]
      : []),
    `When asked about available integrations, supported services, or new connections: read the vault reference file FIRST (action templates table) to see what's supported — before calling vault_connections_list. The reference is the source of truth for supported services; connections only show what's currently active.`,
    `CRITICAL — Enabling vault-managed channels: ALWAYS configure the AgentHiFive channel plugin block, not native telegram/slack channel entries. The minimal shape is { "channels": { "agenthifive": { "accounts": { "default": { "enabled": true, "baseUrl": "<vault-url>", "auth": { "mode": "agent", "agentId": "<agent-id>", "privateKey": "<base64-jwk>" }, "providers": { "telegram": { "enabled": true, "dmPolicy": "balanced", "allowFrom": [] }, "slack": { "enabled": true } } } } } } }. Do NOT add native bot tokens, webhookPath, signingSecret, Socket Mode settings, or native plugin entries for Telegram/Slack.`,
    `NEVER ask users for bot tokens, app tokens, or API keys — the vault injects credentials automatically.`,
    `If the vault returns a "hint" field in an error response, follow its guidance.`,
    `Step-up approvals: when vault_execute returns 202 (approval required), tell the user their request needs approval and to check the dashboard. Do NOT call vault_await_approval — the system will automatically notify you when the approval resolves. When you receive an approval notification, re-submit the exact same vault_execute call with the approvalId provided.`,
  ].join("\n");
  return `<vault-context silent="true">\n${instructions}\n</vault-context>`;
}

// ---------------------------------------------------------------------------
// Inline mode — single prompt string (for MCP server and inline fallback)
// ---------------------------------------------------------------------------

const LLM_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "anthropic-messages",
]);

/**
 * Build a single inline prompt string for the given connected providers.
 *
 * - Skips LLM providers (they don't need API reference docs)
 * - Maps provider names to service groups (e.g. "google-gmail" → "google")
 * - Uses CHUNKED_API_SECTIONS (comprehensive) with fallback to API_REFERENCE_SECTIONS
 * - Always includes base sections (tools, permissions, action templates, notes)
 */
export function buildApiReferencePrompt(providers: string[]): string {
  const apiSections: string[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    if (LLM_PROVIDERS.has(provider)) continue;

    const serviceName = PROVIDER_TO_SERVICE[provider] ?? provider;
    if (seen.has(serviceName)) continue;
    seen.add(serviceName);

    const section =
      CHUNKED_API_SECTIONS[serviceName] ?? API_REFERENCE_SECTIONS[serviceName];
    if (section) {
      apiSections.push(section);
    }
  }

  const baseSections = [
    SECTION_HEADER,
    SECTION_TOOLS,
    SECTION_PERMISSION_FLOW,
    SECTION_ACTION_TEMPLATES,
    SECTION_NOTES,
  ];

  const content = apiSections.length > 0
    ? [...baseSections, ...apiSections].join("\n\n")
    : baseSections.join("\n\n");
  return `<vault-context silent="true">\n${content}\n</vault-context>`;
}

/**
 * Legacy export — full prompt for all known providers.
 * Used by the MCP server.
 */
export const API_REFERENCE_PROMPT = [
  PROMPT_HEADER,
  ...Object.values(API_REFERENCE_SECTIONS),
  PROMPT_FOOTER,
].join("\n\n");
