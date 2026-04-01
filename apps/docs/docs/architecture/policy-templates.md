---
title: Policy Templates Design
sidebar_position: 7
sidebar_label: Policy Templates
description: Comprehensive policy template specifications for Strict, Standard, and Minimal tiers.
---

# Policy Templates Design

This document specifies the comprehensive policy templates for each tier (Strict, Standard, Minimal) across all action types. These templates save users from manually configuring Access Controls, Allowlists, Rate Limits, Time Windows, and Security Guards by providing sensible defaults.

## Template Philosophy

The three tiers represent different security postures:

- **Strict (🔒)**: Maximum security, strict restrictions, business hours only, all applicable guards enabled
- **Standard (🛡️)**: Recommended balance of security and usability, extended hours, essential guards only
- **Minimal (⚡)**: Maximum flexibility, minimal restrictions, 24/7 access, no guards

Each tier is designed to be immediately usable without customization, though advanced users can tweak individual components in the Advanced settings area.

## Template Structure

Each policy template includes:

1. **Access Controls**: What operations are allowed, require approval, or denied
2. **Allowlists**: URL patterns, HTTP methods, and path patterns that define the API surface
3. **Rate Limits**: Request volume, payload size, and response size constraints
4. **Time Windows**: When the agent can operate (day of week, hours, timezone)
5. **Security Guards**: Contextual guards from `packages/contracts/src/contextual-rules.ts`

---

## gmail-read Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Read message metadata (subject, from, to, date), List messages
- **Requires Approval**: Read full message body content
- **Denied**: Read attachments

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/gmail/v1/users/me/messages", "/gmail/v1/users/me/messages/*/metadata"]`

**Rate Limits:**
- maxRequestsPerHour: `50`
- maxPayloadSizeBytes: `1048576` (1 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Read all message content (metadata + body), List messages, Search messages
- **Requires Approval**: Download large attachments (>10 MB)
- **Denied**: None

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/gmail/v1/users/me/messages/*", "/gmail/v1/users/me/threads/*"]`

**Rate Limits:**
- maxRequestsPerHour: `200`
- maxPayloadSizeBytes: `5242880` (5 MB)
- maxResponseSizeBytes: `20971520` (20 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `dest-delete-protect` (Delete Protection)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Read all messages, attachments, threads, labels
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/gmail/v1/users/me/**"]`

**Rate Limits:**
- maxRequestsPerHour: `1000`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `52428800` (50 MB)

**Time Windows:**
- 24/7 access enabled (all days, all hours)

**Security Guards:**
- None (maximum flexibility)

---

## calendar-read Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Read event summaries (title, date, time)
- **Requires Approval**: Read full event details (description, attendees, location)
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/calendar/v3/calendars/*/events"]`

**Rate Limits:**
- maxRequestsPerHour: `50`
- maxPayloadSizeBytes: `524288` (512 KB)
- maxResponseSizeBytes: `2097152` (2 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `cal-external-attendee` (External Attendee Guard - for filtering)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Read all event details, calendar lists, free/busy information
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/calendar/v3/calendars/**", "/calendar/v3/users/me/calendarList"]`

**Rate Limits:**
- maxRequestsPerHour: `200`
- maxPayloadSizeBytes: `2097152` (2 MB)
- maxResponseSizeBytes: `10485760` (10 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Read all calendar data, events, settings
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/calendar/v3/**"]`

**Rate Limits:**
- maxRequestsPerHour: `1000`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `26214400` (25 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## teams-read Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Read message metadata (sender, timestamp, channel)
- **Requires Approval**: Read full message content and threads
- **Denied**: None

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["GET"]`
- Path Patterns: `["/v1.0/teams/*/channels/*/messages", "/v1.0/me/chats/*/messages"]`

**Rate Limits:**
- maxRequestsPerHour: `50`
- maxPayloadSizeBytes: `1048576` (1 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Read all messages, threads, channels, team information
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["GET"]`
- Path Patterns: `["/v1.0/teams/**", "/v1.0/me/chats/**", "/v1.0/me/joinedTeams"]`

**Rate Limits:**
- maxRequestsPerHour: `200`
- maxPayloadSizeBytes: `5242880` (5 MB)
- maxResponseSizeBytes: `20971520` (20 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `dest-delete-protect` (Delete Protection)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Read all Teams data without restrictions
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["GET"]`
- Path Patterns: `["/v1.0/teams/**", "/v1.0/me/**"]`

**Rate Limits:**
- maxRequestsPerHour: `1000`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `52428800` (50 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## slack Templates

:::info All Slack Methods Use POST
Slack's Web API is not standard REST. Every method uses `POST`, even read operations like listing channels or reading message history. All Slack allowlists use `["POST"]` as the method.
:::

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Read messages, channels, users, threads, pins
- **Requires Approval**: Send messages, upload files, edit messages, add reactions, pin messages
- **Denied**: Delete messages, remove pins

**Allowlists:**
- Base URL: `https://slack.com`
- Methods: `["POST"]`
- Path Patterns: `["/api/*"]`

**Rate Limits:**
- maxRequestsPerHour: `50`
- maxPayloadSizeBytes: `1048576` (1 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-profanity` (Profanity Filter)
- `cs-pii-outbound` (PII Outbound Guard)
- `cs-pii-redact` (PII Response Redaction)
- `msg-send-approval` (Send Approval)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Read messages, channels, users, threads, pins, add reactions
- **Requires Approval**: Send messages, upload files, edit messages
- **Denied**: None

**Allowlists:**
- Base URL: `https://slack.com`
- Methods: `["POST"]`
- Path Patterns: `["/api/*"]`

**Rate Limits:**
- maxRequestsPerHour: `200`
- maxPayloadSizeBytes: `5242880` (5 MB)
- maxResponseSizeBytes: `20971520` (20 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-pii-redact` (PII Response Redaction)
- `msg-send-approval` (Send Approval)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Full Slack API access — read, send, edit, delete, upload, react, pin
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://slack.com`
- Methods: `["POST"]`
- Path Patterns: `["/api/*"]`

**Rate Limits:**
- maxRequestsPerHour: `1000`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `52428800` (50 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

### Provider Constraints

Slack policies support optional **provider constraints** for restricting which channels and users the agent can interact with:

- **Allowed Channels** (`allowedChannelIds`): Restricts which channels the agent can read from and post to. Outbound messages to non-allowed channels are blocked (403). Inbound `conversations.list` responses are filtered to only show allowed channels.
- **Allowed Users** (`allowedUserIds`): Filters inbound `conversations.history` and `conversations.replies` responses to only include messages from allowed users. Bot and system messages are always kept.

If either list is empty or omitted, no restriction is applied for that dimension. When a trusted channel list is set, send approval rules are automatically relaxed for trusted channels.

---

## drive-read Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: List file names, folders, metadata (name, size, type, modified date)
- **Requires Approval**: Download/read any file content
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/drive/v3/files", "/drive/v3/files/*/metadata"]`

**Rate Limits:**
- maxRequestsPerHour: `50`
- maxPayloadSizeBytes: `1048576` (1 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `dest-delete-protect` (Delete Protection)
- `fs-dangerous-file` (Dangerous File Type Guard)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Read file metadata, list files/folders
- **Requires Approval**: Download large files (>25 MB)
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/drive/v3/files/**"]`

**Rate Limits:**
- maxRequestsPerHour: `200`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `26214400` (25 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `dest-delete-protect` (Delete Protection)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Read and download all files without restrictions
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["GET"]`
- Path Patterns: `["/drive/v3/**"]`

**Rate Limits:**
- maxRequestsPerHour: `1000`
- maxPayloadSizeBytes: `52428800` (50 MB)
- maxResponseSizeBytes: `104857600` (100 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## Template Progression Summary

Each component follows a consistent progression from Strict → Standard → Minimal:

| Component | Strict | Standard | Minimal |
|-----------|--------|----------|---------|
| **Access Controls** | Highly restricted, frequent approvals | Balanced permissions, occasional approvals | Fully open, no approvals |
| **Rate Limits** | Low (50/hr, 1-5 MB) | Moderate (200/hr, 5-25 MB) | High (1000/hr, 25-100 MB) |
| **Time Windows** | Business hours only (M-F 9-5) | Extended hours (M-Su 6am-10pm) | 24/7 access |
| **Security Guards** | Maximum (all applicable guards) | Essential (standard tier guards only) | None (no guards) |
| **Allowlist Patterns** | Specific endpoints only | Common patterns with wildcards | Broad wildcards |

## Implementation Notes

### Database Schema

The existing `policies` table already supports all these components:

```typescript
{
  allowedModels: ["A" | "B"][];           // Always ["B"] for protected access
  defaultMode: "read_only" | "read_write" | "custom";
  stepUpApproval: "always" | "risk_based" | "never";
  allowlists: Array<{
    baseUrl: string;
    methods: string[];
    pathPatterns: string[];
  }>;
  rateLimits: {
    maxRequestsPerHour: number;
    maxPayloadSizeBytes: number;
    maxResponseSizeBytes: number;
  } | null;
  timeWindows: Array<{
    dayOfWeek: number;
    startHour: number;
    endHour: number;
    timezone: string;
  }>;
  rules: {                                 // JSONB column for policy engine rules
    request: RequestRule[];
    response: ResponseRule[];
  };
}
```

### Guard Application

Guards are applied by:

1. Looking up the guard definition in `contextual-rules.ts`
2. Getting the provider-specific rules for the guard
3. Merging the guard's request and response rules into the policy's `rules` object

Example for `cs-pii-redact` guard on `gmail-read`:

```typescript
// Guard defines a response rule
{
  label: "Redact PII from Gmail responses",
  match: { urlPattern: "^/gmail/v1/users/me/messages" },
  filter: {
    redact: [
      { type: "email" },
      { type: "phone" },
      { type: "ssn" }
    ]
  }
}
```

### Template Application Flow

When a user approves a permission request with a selected tier:

1. Frontend sends `{ allowedModels: ["B"], policyTier: "standard", actionTemplateId: "gmail-read" }`
2. Backend looks up the template specification for `gmail-read` + `standard`
3. Backend generates the policy object with:
   - Access controls → `stepUpApproval` setting
   - Allowlists → `allowlists` array
   - Rate limits → `rateLimits` object
   - Time windows → `timeWindows` array
   - Guards → Merged into `rules.request` and `rules.response`
4. Backend creates the policy and connection records

### Mapping Access Controls to stepUpApproval

- **Strict** tier with frequent approvals → `stepUpApproval: "always"`
- **Standard** tier with occasional approvals → `stepUpApproval: "risk_based"`
- **Minimal** tier with no approvals → `stepUpApproval: "never"`

The policy engine's request rules provide finer-grained control than the legacy `stepUpApproval` enum, but we maintain backward compatibility.

---

## gmail-manage Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Create drafts, create labels
- **Requires Approval**: Send emails (all recipients), Delete messages
- **Denied**: Permanently delete messages (bypass trash)

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["POST", "PUT", "DELETE"]`
- Path Patterns: `["/gmail/v1/users/me/drafts", "/gmail/v1/users/me/labels", "/gmail/v1/users/me/messages/send"]`

**Rate Limits:**
- maxRequestsPerHour: `25`
- maxPayloadSizeBytes: `5242880` (5 MB)
- maxResponseSizeBytes: `1048576` (1 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-profanity` (Profanity Filter)
- `cs-pii-outbound` (PII Outbound Guard)
- `msg-send-approval` (Send Approval - external recipients)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Create drafts, create/modify labels, send internal emails
- **Requires Approval**: Send emails to external recipients, delete messages
- **Denied**: Permanently delete messages (bypass trash)

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["POST", "PUT", "DELETE"]`
- Path Patterns: `["/gmail/v1/users/me/drafts/**", "/gmail/v1/users/me/labels/**", "/gmail/v1/users/me/messages/send", "/gmail/v1/users/me/messages/*/trash"]`

**Rate Limits:**
- maxRequestsPerHour: `100`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `2097152` (2 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-profanity` (Profanity Filter)
- `cs-pii-outbound` (PII Outbound Guard)
- `msg-send-approval` (Send Approval - external recipients only)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Send emails, create/modify/delete drafts, create/modify/delete labels, trash messages
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://gmail.googleapis.com`
- Methods: `["POST", "PUT", "DELETE"]`
- Path Patterns: `["/gmail/v1/users/me/**"]`

**Rate Limits:**
- maxRequestsPerHour: `500`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## calendar-write Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: Create drafts (unsaved events)
- **Requires Approval**: Create/modify events (all), Delete events, Add external attendees
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/calendar/v3/calendars/*/events"]`

**Rate Limits:**
- maxRequestsPerHour: `25`
- maxPayloadSizeBytes: `1048576` (1 MB)
- maxResponseSizeBytes: `524288` (512 KB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cal-external-attendee` (External Attendee Guard - requires approval)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Create/modify internal events, delete own events
- **Requires Approval**: Add external attendees, delete events created by others
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/calendar/v3/calendars/**"]`

**Rate Limits:**
- maxRequestsPerHour: `100`
- maxPayloadSizeBytes: `2097152` (2 MB)
- maxResponseSizeBytes: `1048576` (1 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cal-external-attendee` (External Attendee Guard - requires approval)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Full calendar write access (create/modify/delete events, add any attendees)
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/calendar/v3/**"]`

**Rate Limits:**
- maxRequestsPerHour: `500`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## teams-write Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: None (everything requires approval)
- **Requires Approval**: Send messages, create channels, upload files
- **Denied**: Delete messages, remove members

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/v1.0/teams/*/channels/*/messages", "/v1.0/me/chats/*/messages"]`

**Rate Limits:**
- maxRequestsPerHour: `25`
- maxPayloadSizeBytes: `5242880` (5 MB)
- maxResponseSizeBytes: `1048576` (1 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-profanity` (Profanity Filter)
- `cs-pii-outbound` (PII Outbound Guard)
- `msg-send-approval` (Send Approval)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Send messages to existing channels/chats, upload files
- **Requires Approval**: Create channels, delete messages
- **Denied**: Remove members, delete channels

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/v1.0/teams/*/channels/*/messages", "/v1.0/me/chats/*/messages", "/v1.0/teams/*/channels"]`

**Rate Limits:**
- maxRequestsPerHour: `100`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `2097152` (2 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `cs-profanity` (Profanity Filter)
- `cs-pii-outbound` (PII Outbound Guard)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Full write access (send messages, create/delete channels, upload files, modify settings)
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://graph.microsoft.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/v1.0/teams/**", "/v1.0/me/**"]`

**Rate Limits:**
- maxRequestsPerHour: `500`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## drive-write Templates

### Strict Tier 🔒

**Access Controls:**
- **Allowed**: None (everything requires approval)
- **Requires Approval**: Upload files, create folders, modify files
- **Denied**: Delete files, share files externally, make files public

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/drive/v3/files"]`

**Rate Limits:**
- maxRequestsPerHour: `25`
- maxPayloadSizeBytes: `10485760` (10 MB)
- maxResponseSizeBytes: `1048576` (1 MB)

**Time Windows:**
- Monday-Friday: 9:00 AM - 5:00 PM
- Saturday-Sunday: Disabled
- Timezone: User's workspace timezone

**Security Guards:**
- `fs-public-share` (Block Public Sharing)
- `fs-external-share` (External Sharing Guard)
- `fs-dangerous-file` (Dangerous File Type Guard)
- `dest-delete-protect` (Delete Protection)

### Standard Tier 🛡️ (Recommended)

**Access Controls:**
- **Allowed**: Upload small files (&lt;25 MB), create folders, modify own files
- **Requires Approval**: Upload large files (>25 MB), share files externally, delete files
- **Denied**: Make files publicly accessible

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/drive/v3/files/**", "/drive/v3/files/*/permissions"]`

**Rate Limits:**
- maxRequestsPerHour: `100`
- maxPayloadSizeBytes: `26214400` (25 MB)
- maxResponseSizeBytes: `5242880` (5 MB)

**Time Windows:**
- Monday-Sunday: 6:00 AM - 10:00 PM
- Timezone: User's workspace timezone

**Security Guards:**
- `fs-public-share` (Block Public Sharing)
- `fs-external-share` (External Sharing Guard - requires approval)
- `fs-dangerous-file` (Dangerous File Type Guard)

### Minimal Tier ⚡

**Access Controls:**
- **Allowed**: Full write access (upload/modify/delete files, share internally/externally, create folders)
- **Requires Approval**: None
- **Denied**: None

**Allowlists:**
- Base URL: `https://www.googleapis.com`
- Methods: `["POST", "PUT", "PATCH", "DELETE"]`
- Path Patterns: `["/drive/v3/**"]`

**Rate Limits:**
- maxRequestsPerHour: `500`
- maxPayloadSizeBytes: `104857600` (100 MB)
- maxResponseSizeBytes: `10485760` (10 MB)

**Time Windows:**
- 24/7 access enabled

**Security Guards:**
- None

---

## Future Enhancements

1. **Custom Templates**: Allow advanced users to save their own template presets
2. **Provider-Specific Tweaks**: Adjust templates based on provider-specific capabilities
3. **Usage-Based Recommendations**: Suggest tier adjustments based on actual agent behavior
4. **Template Inheritance**: Allow workspace-level default templates that agents inherit
5. **Hybrid Read-Write Templates**: Combined templates for agents that need both read and write access
6. **Time-Based Restrictions**: Automatically adjust tier based on time of day (e.g., stricter after hours)
