---
title: Policy Guards
sidebar_position: 5
sidebar_label: "Policy Guards"
description: "Contextual policy rules that govern what AI agents can and cannot do across messaging, file sharing, calendar, data reading, and administrative operations."
---

# Policy Guards

Policy guards are contextual rules that inspect, filter, or block agent actions in real time. Each guard targets a specific action type (sending email, sharing files, deleting messages, etc.) and applies one of three enforcement actions:

- **deny** -- Block the action outright.
- **require_approval** -- Pause the action and request human approval before proceeding.
- **filter** -- Allow the action but redact or strip sensitive data from the response.

Guards are organized into **preset tiers** (`standard` and `strict`) so operators can adopt a baseline quickly and customize from there.

---

## Messaging

Guards for sending emails, chat messages, channel posts, replies, and forwarding.

### Email Sending

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `msg-profanity-email` | Profanity filter (email) | Block outbound emails whose body contains profane or offensive language | High | Google, Microsoft | deny |
| `msg-pii-email` | PII guard (email body) | Block or flag emails containing SSNs, credit cards, or other PII in the body | High | Google, Microsoft | require_approval |
| `msg-recipient-limit-email` | Recipient limit (email) | Require approval when sending to more than N recipients (To+Cc+Bcc). Default threshold: 10 | Medium | Google, Microsoft | require_approval |
| `msg-external-domain-email` | External domain guard (email) | Require approval when sending to recipients outside the org domain | High | Google, Microsoft | require_approval |
| `msg-attachment-guard-email` | Attachment type guard (email) | Block emails with executable or script attachments (.exe, .bat, .ps1, .sh, .js) | High | Google, Microsoft | deny |

### Chat Sending

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `msg-profanity-chat` | Profanity filter (chat) | Block chat messages containing profane or offensive language | Medium | Microsoft, Telegram | deny |
| `msg-pii-chat` | PII guard (chat) | Block or flag chat messages containing PII | Medium | Microsoft, Telegram | require_approval |
| `msg-link-guard-chat` | External link guard (chat) | Flag messages containing URLs to external domains | Low | Microsoft, Telegram | require_approval |

### Channel Posts

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `msg-profanity-channel` | Profanity filter (channel post) | Block channel/group posts containing profane language | High | Microsoft, Telegram | deny |
| `msg-pii-channel` | PII guard (channel post) | Block channel posts containing PII. Audience amplification makes PII leaks worse in channels | High | Microsoft, Telegram | deny |
| `msg-audience-limit-channel` | Audience size guard (channel) | Require approval for posts to channels/groups with many members. Default threshold: 50 | High | Microsoft, Telegram | require_approval |

### Replies and Forwarding

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `msg-profanity-reply` | Profanity filter (reply) | Block reply messages containing profane language | Medium | Google, Microsoft, Telegram | deny |
| `msg-forward-guard` | Forward message guard | Require approval or block message forwarding. Forwarding can leak context to unintended recipients | Medium | Telegram | require_approval |

---

## File Sharing

Guards for sharing, uploading, and sending files and media.

### Sharing

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `fs-public-share-block` | Block public sharing | Block sharing files with public/anonymous access | High | Google, Microsoft | deny |
| `fs-external-share-guard` | External sharing guard | Require approval for sharing with external users/domains | High | Google, Microsoft | require_approval |
| `fs-link-sharing-block` | Block link sharing | Block creating shareable links (domain-wide or public) | Medium | Google | deny |

### Uploading

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `fs-file-type-guard` | File type guard (upload) | Block uploading executable or script files (.exe, .bat, .ps1, .sh, .js, .vbs, .msi, .dll) | High | Google, Microsoft | deny |
| `fs-file-size-guard` | File size guard | Require approval for uploads exceeding size threshold. Default: 25 MB | Medium | Google, Microsoft | require_approval |
| `fs-sensitive-filename` | Sensitive filename guard | Block uploads with filenames suggesting credentials or secrets (password\*, secret\*, credential\*, .env, .pem) | High | Google, Microsoft | deny |

### Media (Telegram)

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `fs-media-type-telegram` | Media type guard (Telegram) | Restrict which media types can be sent. Approval for document sending; photos/videos may auto-allow | Medium | Telegram | require_approval |

---

## Calendar

Guards for creating and modifying calendar events.

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `cal-external-attendee` | External attendee guard | Require approval when inviting attendees outside the org | High | Google, Microsoft | require_approval |
| `cal-large-meeting` | Large meeting guard | Require approval for events with many attendees. Default threshold: 20 | Medium | Google, Microsoft | require_approval |
| `cal-off-hours` | Off-hours booking guard | Flag events created outside business hours. Business hours configurable per timezone | Low | Google, Microsoft | require_approval |
| `cal-cancel-guard` | Event cancellation guard | Require approval before canceling events with 2+ attendees | Medium | Google, Microsoft | require_approval |

---

## Data Reading

Response-side guards that filter or redact sensitive information from API responses.

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `dr-strip-contact-pii` | Strip contact PII | Remove phone numbers, addresses, and birthdays from contact responses | Medium | Google, Microsoft | filter |
| `dr-redact-contact-email` | Redact contact emails | Redact email addresses in contact/directory responses | Medium | Google, Microsoft | filter |
| `dr-redact-message-pii` | Redact PII in messages | Redact PII (SSN, phone, credit card) found in read message responses | Medium | Google, Microsoft, Telegram | filter |
| `dr-redact-file-metadata` | Redact file metadata PII | Redact owner PII from file listing responses | Low | Google, Microsoft | filter |
| `dr-rate-limit-search` | Search rate limit | Limit search query frequency to prevent data exfiltration | Medium | Google, Microsoft | allow |

---

## Destructive

Guards that protect against data deletion, member removal, and permission revocation.

### Message Deletion

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `dest-delete-msg-block` | Block message deletion | Block agent from deleting messages. Prevents evidence destruction or disruption | High | Microsoft, Telegram | deny |
| `dest-delete-msg-approve` | Approve message deletion | Require approval for message deletion (less strict alternative) | Medium | Microsoft, Telegram | require_approval |

### File Deletion

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `dest-delete-file-approve` | Approve file deletion | Require approval before deleting files | High | Google, Microsoft | require_approval |
| `dest-delete-file-block` | Block file deletion | Block agent from deleting any files (strictest mode) | High | Google, Microsoft | deny |

### Member Removal

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `dest-kick-block` | Block member removal | Block agent from kicking/banning members | High | Telegram | deny |
| `dest-kick-approve` | Approve member removal | Require approval before kicking/banning members | High | Telegram | require_approval |

### Permission Revocation

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `dest-revoke-perm-approve` | Approve permission revocation | Require approval before revoking file/resource permissions | Medium | Google, Microsoft | require_approval |

---

## Administrative

Guards for role management, settings changes, and member additions.

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `adm-role-change-block` | Block role changes | Block agent from modifying user/member roles. Prevents privilege escalation | High | Microsoft | deny |
| `adm-settings-approve` | Approve settings changes | Require approval for any settings modification | High | Google, Microsoft | require_approval |
| `adm-member-add-approve` | Approve member additions | Require approval before adding members to teams/groups | Medium | Microsoft, Telegram | require_approval |

---

## Content Safety

Cross-cutting guards that apply to all outbound or inbound content regardless of action type.

### Outbound (Request-Side)

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `cs-profanity-global` | Global profanity filter | Block any outbound content containing profane language. Applies to all write operations | High | Google, Microsoft, Telegram | deny |
| `cs-pii-global` | Global PII guard | Flag any outbound content containing PII (SSN, credit card, phone patterns). Applies to all write operations | High | Google, Microsoft, Telegram | require_approval |
| `cs-ip-address-guard` | IP address leak guard | Block outbound content containing internal IP addresses (10.x, 192.168.x, 172.16-31.x) | Medium | Google, Microsoft, Telegram | deny |

### Inbound (Response-Side)

| Guard ID | Name | Description | Risk | Providers | Action |
|---|---|---|---|---|---|
| `cs-pii-redact-global` | Global PII redaction | Redact PII (email, phone, SSN, credit card, IP address) from all API responses | Medium | Google, Microsoft, Telegram | filter |

---

## Summary by Action Type

| Action Type | Total Guards | deny | require_approval | filter |
|---|---|---|---|---|
| Messaging | 13 | 6 | 7 | 0 |
| File Sharing | 7 | 4 | 3 | 0 |
| Calendar | 4 | 0 | 4 | 0 |
| Data Reading | 5 | 0 | 0 | 4 |
| Destructive | 7 | 3 | 4 | 0 |
| Administrative | 3 | 1 | 2 | 0 |
| Content Safety | 4 | 2 | 1 | 1 |
| **Total** | **43** | **16** | **21** | **5** |

---

:::tip Download
For the complete dataset with all fields, download the source CSV:
[Download full CSV](/assets/contextual_rules_matrix.csv)
:::
