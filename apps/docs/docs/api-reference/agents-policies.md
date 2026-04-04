---
title: Agents & Policies
sidebar_position: 6
sidebar_label: Agents & Policies
description: API endpoints for agent registration and policy-based access control -- allowlists, rate limits, time windows, and rules.
---

# Agents & Policies

Agents represent AI applications registered in your workspace. Policies bind agents to connections and define what the agent is allowed to do -- execution models, access modes, allowlists, rate limits, time windows, and custom rules.

## Agents

### Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/agents` | Create agent (returns bootstrap secret) |
| `GET` | `/v1/agents` | List agents |
| `GET` | `/v1/agents/:id` | Get agent by ID |
| `PUT` | `/v1/agents/:id` | Update agent |
| `DELETE` | `/v1/agents/:id` | Delete agent (cascades to policies) |
| `POST` | `/v1/agents/:id/bootstrap-secret` | Generate a bootstrap secret for enrollment or key rotation |
| `POST` | `/v1/agents/:id/disable` | Disable agent (revokes all tokens) |
| `POST` | `/v1/agents/:id/enable` | Re-enable a disabled agent |

### Agent Lifecycle

Agents follow a three-state lifecycle:

| State | Description |
|---|---|
| `created` | Agent registered but not yet enrolled (awaiting public key) |
| `active` | Agent enrolled with an ES256 public key; can authenticate and call the Vault |
| `disabled` | Agent suspended; all access tokens revoked, new token exchange rejected |

Transitions: `created` → `active` (via [bootstrap](./agent-auth.md#bootstrap)) → `disabled` (via disable endpoint) → `active` (via enable endpoint). Re-bootstrapping an active agent replaces the public key and invalidates all tokens without changing state.

### Create Agent

```
POST /v1/agents
```

Creates a new agent and returns a one-time bootstrap secret. The agent must complete the [bootstrap flow](./agent-auth.md#bootstrap) within 1 hour to become active.

**Request**:

```json
{
  "name": "Email Assistant",
  "description": "Reads and drafts emails on behalf of the user",
  "iconUrl": "https://example.com/icon.png"
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Agent name (non-empty string) |
| `description` | No | Agent description |
| `iconUrl` | No | URL for the agent icon |

**Response**:

```json
{
  "agent": {
    "id": "uuid",
    "name": "Email Assistant",
    "description": "Reads and drafts emails on behalf of the user",
    "iconUrl": "https://example.com/icon.png",
    "status": "created",
    "enrolledAt": null,
    "createdAt": "2025-06-01T00:00:00Z"
  },
  "bootstrapSecret": "ah5b_aBcDeFgHiJkLmNoPqRsTuVwXyZ..."
}
```

The `bootstrapSecret` is shown **only once** on creation and cannot be retrieved later. Only the SHA-256 hash is stored. The secret expires in 1 hour (configurable via `BOOTSTRAP_SECRET_TTL_HOURS`).

### List Agents

```
GET /v1/agents
```

Returns all agents in the current workspace. Each agent includes a `status` field (`created`, `active`, or `disabled`).

### Get Agent by ID

```
GET /v1/agents/:id
```

Returns agent details including `status`, `enrolledAt` (null if not yet enrolled), and `updatedAt`.

### Update Agent

```
PUT /v1/agents/:id
```

Updates name, description, and/or icon URL. At least one field must be provided.

### Delete Agent

```
DELETE /v1/agents/:id
```

Permanently deletes an agent. Associated policies, access tokens, and approval requests are removed via cascading foreign keys.

### Generate Bootstrap Secret

```
POST /v1/agents/:id/bootstrap-secret
```

Generates a one-time bootstrap secret for agent enrollment or key rotation. Works for agents in `created` or `active` status (rejects `disabled` agents).

**Response**:

```json
{
  "bootstrapSecret": "ah5b_aBcDeFgHiJkLmNoPqRsTuVwXyZ..."
}
```

The bootstrap secret expires in 1 hour (configurable via `BOOTSTRAP_SECRET_TTL_HOURS`). When the agent completes the [bootstrap flow](./agent-auth.md#bootstrap), the public key is registered (or replaced) and any existing access tokens are invalidated.

### Disable Agent

```
POST /v1/agents/:id/disable
```

Disables the agent immediately. All outstanding access tokens are deleted and new token exchanges are rejected.

**Response**:

```json
{
  "success": true,
  "tokensRevoked": 3
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `true` on success |
| `tokensRevoked` | `number` | Number of access tokens that were revoked |

### Enable Agent

```
POST /v1/agents/:id/enable
```

Re-enables a disabled agent. If the agent has a public key on file, the status returns to `active`. If not (e.g., never enrolled), the status returns to `created`.

**Response**:

```json
{
  "success": true,
  "status": "active"
}
```

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Always `true` on success |
| `status` | `string` | New agent status: `"created"` or `"active"` |

---

## Policies

A policy is a binding between an agent and a connection. It controls which execution models are allowed, the access mode, step-up approval behavior, and fine-grained rules.

### Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/policies` | Create policy |
| `GET` | `/v1/policies` | List policies |
| `PUT` | `/v1/policies/:id` | Update policy settings |
| `PUT` | `/v1/policies/:id/allowlists` | Set allowlist rules |
| `PUT` | `/v1/policies/:id/rate-limits` | Set rate limits |
| `PUT` | `/v1/policies/:id/time-windows` | Set time windows |
| `GET` | `/v1/policies/:id/rules` | Get policy rules |
| `PUT` | `/v1/policies/:id/rules` | Set policy rules |
| `PUT` | `/v1/policies/:id/provider-constraints` | Set provider constraints (chat/channel restrictions) |
| `DELETE` | `/v1/policies/:id` | Delete policy |

### Create Policy

```
POST /v1/policies
```

Creates a policy binding between an agent and a connection. Both must belong to the current workspace.

Allowlists are **auto-populated** with service-specific defaults based on the connection's service (e.g., a Gmail connection gets allowlists scoped to `https://www.googleapis.com/gmail/v1/*`, a Telegram connection gets `https://api.telegram.org/bot*/*`). This means newly created policies work out of the box for Model B execution. You can customize allowlists later via `PUT /v1/policies/:id/allowlists`.

**Request**:

```json
{
  "agentId": "uuid",
  "connectionId": "uuid",
  "allowedModels": ["A", "B"],
  "defaultMode": "read_only",
  "stepUpApproval": "risk_based"
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `agentId` | Yes | -- | Agent to bind |
| `connectionId` | Yes | -- | Connection to bind |
| `allowedModels` | No | `["A", "B"]` | Execution models: `"A"` (token vending), `"B"` (brokered proxy) |
| `defaultMode` | No | `"read_only"` | Access mode: `read_only`, `read_write`, `custom` |
| `stepUpApproval` | No | `"risk_based"` | Approval mode: `always`, `risk_based`, `never` |

### List Policies

```
GET /v1/policies
```

Returns all policies for the current workspace (scoped through workspace agents).

### Update Policy

```
PUT /v1/policies/:id
```

Updates `allowedModels`, `defaultMode`, and/or `stepUpApproval`.

### Delete Policy

```
DELETE /v1/policies/:id
```

Removes the policy binding. The agent will no longer have access through this connection.

---

### Set Allowlists

```
PUT /v1/policies/:id/allowlists
```

Configures URL allowlists for Model B execution. Requests that do not match any allowlist entry are denied (default-deny).

**Request**:

```json
{
  "allowlists": [
    {
      "baseUrl": "https://gmail.googleapis.com",
      "methods": ["GET"],
      "pathPatterns": ["/gmail/v1/users/me/messages/*", "/gmail/v1/users/me/labels"]
    },
    {
      "baseUrl": "https://gmail.googleapis.com",
      "methods": ["POST"],
      "pathPatterns": ["/gmail/v1/users/me/messages/send"]
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `baseUrl` | Yes | HTTPS base URL (HTTP is rejected) |
| `methods` | Yes | Allowed HTTP methods: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `pathPatterns` | Yes | URL path patterns with wildcard support (e.g., `/users/me/messages/*`) |

**Path pattern matching**: `*` at the end of a pattern matches any suffix. For example, `/users/me/messages/*` matches `/users/me/messages/123` and `/users/me/messages/123/attachments`.

---

### Set Rate Limits

```
PUT /v1/policies/:id/rate-limits
```

Configures rate limits and size constraints. Pass `null` for `rateLimits` to remove all limits.

**Request**:

```json
{
  "rateLimits": {
    "maxRequestsPerHour": 100,
    "maxPayloadSizeBytes": 1048576,
    "maxResponseSizeBytes": 10485760
  }
}
```

| Field | Required | Description |
|---|---|---|
| `maxRequestsPerHour` | Yes (if setting limits) | Max requests per hour per agent+connection pair |
| `maxPayloadSizeBytes` | No | Max request body size in bytes |
| `maxResponseSizeBytes` | No | Max response size in bytes |

Rate limits are enforced per agent+connection pair using audit event counts from the past hour.

---

### Set Time Windows

```
PUT /v1/policies/:id/time-windows
```

Restricts execution to specific time windows. Requests outside all configured windows are denied.

**Request**:

```json
{
  "timeWindows": [
    {
      "dayOfWeek": 1,
      "startHour": 9,
      "endHour": 17,
      "timezone": "America/New_York"
    },
    {
      "dayOfWeek": 2,
      "startHour": 9,
      "endHour": 17,
      "timezone": "America/New_York"
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `dayOfWeek` | Yes | 0 = Sunday, 1 = Monday, ..., 6 = Saturday |
| `startHour` | Yes | Start hour (0-23, inclusive) |
| `endHour` | Yes | End hour (0-23, inclusive) |
| `timezone` | Yes | IANA timezone (e.g., `America/New_York`, `Europe/London`) |

Pass an empty array to remove all time window restrictions.

---

### Get/Set Policy Rules

```
GET /v1/policies/:id/rules
PUT /v1/policies/:id/rules
```

Policy rules provide fine-grained request evaluation (pre-execution) and response filtering (post-execution).

**Request rules** are evaluated before execution. First match wins with action: `allow`, `deny`, or `require_approval`.

**Response rules** filter the provider response before returning to the agent (field allowlists, denylists, and PII redaction).

**PUT request body**:

```json
{
  "rules": {
    "request": [
      {
        "label": "Block delete operations",
        "match": {
          "methods": ["DELETE"],
          "urlPattern": ".*"
        },
        "action": "deny"
      },
      {
        "label": "Require approval for sending emails",
        "match": {
          "methods": ["POST"],
          "urlPattern": ".*/messages/send"
        },
        "action": "require_approval"
      }
    ],
    "response": [
      {
        "label": "Redact PII from responses",
        "match": {
          "urlPattern": ".*/messages/.*",
          "methods": ["GET"]
        },
        "filter": {
          "redact": [
            { "type": "email" },
            { "type": "phone" },
            { "type": "ssn" }
          ]
        }
      }
    ]
  }
}
```

**Request rule match conditions**:

| Field | Description |
|---|---|
| `methods` | HTTP methods to match |
| `urlPattern` | Regex pattern matched against the URL path |
| `body` | Array of body field matchers with `path`, `op` (`eq`, `neq`, `in`, `not_in`, `contains`, `matches`, `exists`), and `value` |

**Response filter options**:

| Field | Description |
|---|---|
| `allowFields` | Only include these fields in the response |
| `denyFields` | Remove these fields from the response |
| `redact` | PII redaction rules: `email`, `phone`, `ssn`, `credit_card`, `ip_address`, or `custom` with a regex `pattern` and `replacement` |

### Update Provider Constraints

```
PUT /v1/policies/:id/provider-constraints
```

Sets provider-specific access constraints. These restrict which chats, channels, or tenants an agent can interact with through a connection.

**Telegram** constraints are bidirectional: they restrict both who can send messages to the agent and who the agent can send to. If `allowedChatIds` is empty, all users are allowed (open).

**Microsoft Teams** constraints are opt-in: if not configured, all chats/channels/tenants are allowed.

**Slack** constraints support two dimensions — channels and users. `allowedChannelIds` restricts which channels the agent can read from and post to. `allowedUserIds` filters inbound messages to only show messages from allowed users. If either is empty or omitted, no restriction is applied for that dimension.

**Request body** (Telegram):

```json
{
  "providerConstraints": {
    "provider": "telegram",
    "allowedChatIds": ["-1001234567890", "987654321"]
  }
}
```

**Request body** (Microsoft Teams):

```json
{
  "providerConstraints": {
    "provider": "microsoft",
    "allowedTenantIds": ["tenant-uuid"],
    "allowedChatIds": ["chat-id"],
    "allowedChannelIds": ["channel-id"]
  }
}
```

**Request body** (Slack):

```json
{
  "providerConstraints": {
    "provider": "slack",
    "allowedChannelIds": ["C0123456789", "C9876543210"],
    "allowedUserIds": ["U0123456789"]
  }
}
```

Pass `null` to clear all constraints:

```json
{ "providerConstraints": null }
```

The `provider` field must match the connection's provider. Setting Telegram constraints on a Google connection returns `400`.

## Templates

Pre-built allowlist templates and rule presets are available via the Templates endpoints:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/templates/:provider` | Get allowlist templates for a provider |
| `GET` | `/v1/templates/:provider/rules` | Get rule presets (minimal/standard/strict) and individual rule templates |
| `GET` | `/v1/templates/:provider/guards` | Get contextual security guards by action category |

Supported providers: `google`, `microsoft`, `telegram`, `slack`.
