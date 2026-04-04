---
title: Capabilities
sidebar_position: 7
sidebar_label: Capabilities
description: API endpoints for discovering services and querying agent capabilities.
---

# Capabilities

The capabilities endpoints let agents and dashboards discover available services, check active permissions, and identify what actions can still be requested.

## Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/capabilities/services` | List all services and action templates |
| `GET` | `/v1/capabilities/me` | Get calling agent's capability status |

Both endpoints require the `capabilities:read` scope.

## List Services

```
GET /v1/capabilities/services
```

Returns the full AgentHiFive service catalog with available action templates per service. This is static data derived from the service catalog — no database query is made.

**Response**:

```json
{
  "services": [
    {
      "id": "google-gmail",
      "name": "Gmail",
      "provider": "google",
      "icon": "gmail",
      "singleton": false,
      "actions": [
        {
          "id": "gmail-read",
          "label": "Read Gmail",
          "description": "Read messages and search",
          "requiresApproval": false
        }
      ]
    },
    {
      "id": "telegram",
      "name": "Telegram",
      "provider": "telegram",
      "icon": "telegram",
      "singleton": true,
      "actions": [
        {
          "id": "telegram",
          "label": "Telegram Bot",
          "description": "Send/receive messages via bot",
          "requiresApproval": false
        }
      ]
    }
  ],
  "oauthStatus": {
    "google": { "available": true, "source": "platform" },
    "microsoft": { "available": false, "source": null }
  }
}
```

The `oauthStatus` object indicates whether OAuth credentials are configured for each provider that requires them. `available` is `true` if credentials exist (from platform defaults or workspace-level custom apps). `source` indicates the credential origin (`null` if unavailable).

## Get My Capabilities

```
GET /v1/capabilities/me
```

Returns the calling agent's current capability status. **Requires an agent access token** (`Authorization: Bearer ah5t_...`) — user JWTs receive a 403.

**Response**:

```json
{
  "activeConnections": [
    {
      "connectionId": "uuid-or-null",
      "service": "google-gmail",
      "provider": "google",
      "status": "healthy",
      "credentialType": "oauth",
      "category": "data",
      "displayName": "Gmail",
      "label": "Work Gmail",
      "actionTemplateId": "gmail-read"
    }
  ],
  "pendingRequests": [
    {
      "id": "uuid",
      "actionTemplateId": "gmail-send",
      "reason": "Need to send emails on behalf of user",
      "requestedAt": "2026-01-15T10:00:00Z"
    }
  ],
  "availableActions": [
    {
      "id": "calendar-read",
      "serviceId": "google-calendar",
      "label": "Read Calendar",
      "description": "Read events",
      "requiresApproval": false
    }
  ]
}
```

| Section | Description |
|---|---|
| `activeConnections` | Connections with policies granted to this agent. Includes `provider`, `status`, `credentialType`, `category`, and `displayName` from the service catalog. For **singleton services** (Telegram, Anthropic), `connectionId` is `null` — use `service` name with `vault_execute` instead. |
| `pendingRequests` | This agent's unresolved permission requests (status = `pending` only). Approved/denied requests are excluded. |
| `availableActions` | Action templates not covered by any active connection or pending request — actions the agent can still request. |

:::tip Singleton Services
Telegram and Anthropic are singleton services (one connection per workspace). Their `connectionId` is always `null` in this response. Agents should use `service: "telegram"` or `service: "anthropic-messages"` when calling `vault_execute`, not a connection UUID.
:::
