---
title: Connections
sidebar_position: 3
sidebar_label: Connections
description: API endpoints for managing OAuth connections -- initiation, callback, revocation, and reauthentication.
---

# Connections

Connections represent authenticated links to third-party providers (Google, Microsoft, Telegram). Each connection stores encrypted OAuth tokens or bot tokens and is scoped to a workspace.

## Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/connections` | List active connections |
| `POST` | `/v1/connections/start` | Start OAuth flow |
| `POST` | `/v1/connections/telegram` | Connect a Telegram bot |
| `GET` | `/v1/connections/callback` | OAuth callback (no auth required) |
| `POST` | `/v1/connections/:id/revoke` | Revoke a connection |
| `POST` | `/v1/connections/:id/reauth` | Start reauthentication flow |
| `PUT` | `/v1/connections/:id/label` | Update connection label |

## List Connections

```
GET /v1/connections
```

Returns active connections (excludes revoked) for the current workspace with their associated policies. Encrypted tokens are never exposed.

**Response**:

```json
{
  "connections": [
    {
      "id": "uuid",
      "provider": "google",
      "service": "google-gmail",
      "label": "Gmail connection",
      "status": "healthy",
      "singleton": false,
      "grantedScopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "metadata": {},
      "createdAt": "2025-06-01T00:00:00Z",
      "policies": [
        {
          "id": "uuid",
          "agentId": "uuid",
          "agentName": "My Agent",
          "defaultMode": "read_only",
          "stepUpApproval": "risk_based",
          "allowedModels": ["A", "B"],
          "allowlists": [],
          "rateLimits": null,
          "timeWindows": []
        }
      ]
    }
  ]
}
```

| Field | Description |
|---|---|
| `singleton` | `true` for services with one connection per workspace (Telegram, Anthropic). Agents should use `service` name instead of `id` for singleton connections. |

**Connection statuses**: `healthy`, `needs_reauth`, `revoked`

## Start OAuth Flow

```
POST /v1/connections/start
```

Initiates an OAuth 2.0 authorization code flow with PKCE. Returns a URL to redirect the user to.

**Request body**:

```json
{
  "service": "google-gmail",
  "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
  "label": "My Gmail",
  "agentId": "uuid",
  "allowedModels": ["A", "B"]
}
```

| Field | Required | Description |
|---|---|---|
| `service` | Yes | Service ID from the catalog (e.g., `google-gmail`, `google-drive`, `microsoft-teams`) |
| `scopes` | Yes | OAuth scopes to request |
| `label` | No | Display label (defaults to service name) |
| `agentId` | No | If set, auto-creates a policy binding after the connection completes |
| `allowedModels` | No | Execution models for auto-created policy (defaults to `["B"]`) |

**Response**:

```json
{
  "pendingConnectionId": "uuid",
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

Redirect the user's browser to `authorizationUrl`. After authorization, the provider redirects to the callback endpoint.

## Connect Telegram Bot

```
POST /v1/connections/telegram
```

Validates a Telegram bot token via the `getMe` API and stores it encrypted.

**Request body**:

```json
{
  "botToken": "123456789:ABCdefGhIjKlMnOpQrStUvWxYz",
  "label": "Support Bot"
}
```

| Field | Required | Description |
|---|---|---|
| `botToken` | Yes | Bot token from BotFather |
| `label` | No | Display label (defaults to `Telegram @username`) |

:::tip
To restrict which chats the bot can interact with, configure **provider constraints** on the policy via [`PUT /v1/policies/:id/provider-constraints`](./agents-policies.md#update-provider-constraints).
:::

**Response**:

```json
{
  "connection": { "id": "uuid", "provider": "telegram", "label": "Telegram @mybot", "status": "healthy" },
  "botInfo": { "id": 123456789, "username": "mybot", "firstName": "My Bot" },
  "message": "Telegram bot connected successfully"
}
```

## Revoke Connection

```
POST /v1/connections/:id/revoke
```

Immediately revokes a connection. All encrypted tokens (OAuth tokens, bot tokens) are permanently destroyed. The connection row is retained for audit trail but hidden from `GET /v1/connections`. All token vending (Model A) and execution (Model B) requests are blocked.

**Response**:

```json
{
  "connection": { "id": "uuid", "provider": "google", "label": "Gmail", "status": "revoked" },
  "auditId": "uuid"
}
```

## Reauthenticate Connection

```
POST /v1/connections/:id/reauth
```

Starts a new OAuth flow for a connection with status `needs_reauth`. Preserves existing policies and metadata. Not available for Telegram connections (delete and recreate instead).

**Response**: Same shape as `POST /v1/connections/start`.

## Update Connection Label

```
PUT /v1/connections/:id/label
```

**Request body**:

```json
{ "label": "New display name" }
```

:::note Provider Constraints Moved to Policy Layer
Telegram chat ID restrictions, Microsoft Teams tenant/chat/channel restrictions, and Slack channel/user restrictions are now managed as **policy provider constraints** rather than connection settings. See [`PUT /v1/policies/:id/provider-constraints`](./agents-policies.md#update-provider-constraints).
:::
