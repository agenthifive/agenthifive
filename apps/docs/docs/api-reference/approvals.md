---
title: Approvals
sidebar_position: 5
sidebar_label: Approvals
description: Step-up approval workflow endpoints for reviewing and acting on sensitive agent actions.
---

# Approvals

When a Model B execution request triggers step-up approval (based on the policy's `stepUpApproval` setting or a policy rule action), the request is paused and an approval request is created. A human reviewer can then approve or deny the request.

## How Approvals Work

1. An agent sends a Model B execution request (e.g., `POST` to send an email)
2. The policy engine determines approval is required (based on `stepUpApproval` mode or a custom rule with `require_approval` action)
3. The execution gateway returns `202` with an `approvalRequestId`
4. The approval appears in the dashboard for workspace members to review
5. A reviewer approves or denies the request
6. If approved, the agent re-submits the original request via `POST /v1/vault/execute` with the `approvalId` to execute it

Approval requests expire after **5 minutes**. Expired requests cannot be approved.

## Step-Up Approval Modes

The `stepUpApproval` field on a policy controls when approval is triggered:

| Mode | Behavior |
|---|---|
| `always` | Every request requires approval |
| `risk_based` | Write methods (`POST`, `PUT`, `PATCH`, `DELETE`) require approval; reads pass through |
| `never` | No approval required |

Custom policy rules can override these modes. A rule action of `require_approval` forces approval regardless of the mode, and a rule action of `allow` skips approval even for write methods.

## Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/approvals` | List approval requests |
| `GET` | `/v1/approvals/:id` | Get approval details |
| `POST` | `/v1/approvals/:id/approve` | Approve request |
| `POST` | `/v1/approvals/:id/deny` | Deny the request |

## List Approval Requests

```
GET /v1/approvals
```

Returns all approval requests for the current workspace, including pending, approved, denied, and expired. Stale pending requests are auto-expired on each query.

**Response**:

```json
{
  "approvals": [
    {
      "id": "uuid",
      "policyId": "uuid",
      "agentId": "uuid",
      "connectionId": "uuid",
      "actor": "user-id",
      "status": "pending",
      "requestDetails": {
        "method": "POST",
        "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        "body": { "raw": "..." },
        "emailMetadata": { "to": "user@example.com", "subject": "Hello" }
      },
      "expiresAt": "2025-06-01T00:05:00Z",
      "createdAt": "2025-06-01T00:00:00Z",
      "agentName": "Email Agent",
      "connectionLabel": "Gmail - Work",
      "connectionProvider": "google"
    }
  ]
}
```

**Approval statuses**: `pending`, `approved`, `denied`, `expired`, `consumed`

The `requestDetails` object contains the original Model B request parameters (method, URL, headers, body) plus provider-specific metadata when available:

- **Gmail**: `emailMetadata` with `to`, `cc`, `bcc`, `subject` fields
- **Telegram**: `telegramMetadata` with `chatId`, `text` fields
- **Teams**: `teamsMetadata` with `chatId`, `channelId`, `teamId`, `contentType`, `content` fields

## Get Approval Details

```
GET /v1/approvals/:id
```

Returns full details for a single approval request.

## Approve Request

```
POST /v1/approvals/:id/approve
```

Approves a pending approval request. This does **not** execute the original request. Instead, the agent must re-submit the request via `POST /v1/vault/execute` with the `approvalId` to bypass the guard and execute it.

**Response (200)**:

```json
{
  "approved": true,
  "approvalRequestId": "uuid",
  "auditId": "uuid"
}
```

| Status | Description |
|---|---|
| `200` | Approved successfully (agent must re-submit via `POST /v1/vault/execute` with `approvalId`) |
| `404` | Approval request not found |
| `409` | Already approved, denied, or connection revoked |
| `410` | Approval request has expired |

## Deny Request

```
POST /v1/approvals/:id/deny
```

Denies a pending approval request. The original action is not executed.

**Response**:

```json
{
  "denied": true,
  "approvalRequestId": "uuid",
  "auditId": "uuid"
}
```

| Status | Description |
|---|---|
| `200` | Successfully denied |
| `404` | Approval request not found |
| `409` | Already approved or denied |
| `410` | Approval request has expired |
