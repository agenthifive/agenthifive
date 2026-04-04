---
title: Gateway Plugin Guide
sidebar_position: 2
sidebar_label: Plugin Guide
description: Install, configure, and use the @agenthifive/agenthifive Gateway plugin to give OpenClaw agents secure access to provider APIs.
---

# Gateway Plugin Guide

The `@agenthifive/agenthifive` package is a first-class OpenClaw Gateway plugin that registers six tools (`vault_execute`, `request_permission`, `request_capability`, `vault_await_approval`, `vault_connections_list`, `vault_connection_revoke`). The plugin runs in-process with the Gateway (trusted boundary) and communicates with the AgentHiFive Vault to execute provider API calls, manage connections, and enforce step-up approvals.

:::tip Key invariant
The plugin stores only Vault session credentials and connection IDs. Provider refresh tokens are **never** stored on the OpenClaw host.
:::

## Plugin Architecture

The `@agenthifive/agenthifive` package serves two roles simultaneously within the OpenClaw Gateway:

### Generic plugin

As a standard OpenClaw plugin it provides:

- **Vault tools** -- six tools (`vault_execute`, `request_permission`, `request_capability`, `vault_await_approval`, `vault_connections_list`, `vault_connection_revoke`) that let agents interact with provider APIs through the AgentHiFive Vault.
- **Hooks** -- a `before_agent_start` hook that injects vault reference files and a system prompt so the agent knows which services and action templates are available.
- **Credential provider** -- a `VaultCredentialProvider` registered at startup so that OpenClaw's built-in provider routing can resolve credentials from the vault when needed.

### Channel plugin

The package also registers the **`agenthifive`** channel via OpenClaw's `createChatChannelPlugin` SDK. This channel enables the agent to receive inbound messages from -- and send outbound messages to -- vault-managed Slack and Telegram bots. See the [Channel Plugin](#channel-plugin) section below for details.

Both roles share a single `VaultActionProxy` instance and a single `VaultTokenManager`, so there is no duplicate token refresh or auth overhead.

## Channel Plugin

The `agenthifive` channel is an OpenClaw chat-channel plugin that routes messaging through the AgentHiFive Vault instead of calling the Slack or Telegram APIs directly.

### Why a separate channel?

OpenClaw ships with native Slack and Telegram channels. Those channels require the bot token to be stored in the OpenClaw Gateway config. The `agenthifive` channel differs in that **tokens stay in the AgentHiFive Vault** -- the Gateway never sees them. All outbound API calls go through `POST /v1/vault/execute`, and all inbound messages are fetched by polling the vault's message stream.

| | Native channels | `agenthifive` channel |
|---|---|---|
| Token storage | Gateway config | AgentHiFive Vault |
| Policy enforcement | None | Vault allowlist + step-up approval |
| Audit trail | Gateway logs only | Vault audit log with `auditId` per action |
| Multi-account | One bot per channel | Multiple accounts via `channels.agenthifive.accounts` |

Use the `agenthifive` channel when you need vault-managed credentials, policy enforcement, or centralized audit. Use the native channels when you manage bot tokens yourself and do not need vault features.

### Sub-provider architecture

The `agenthifive` channel is a single OpenClaw channel that multiplexes two sub-providers:

- **Slack** -- inbound messages are polled via a Slack gateway (`startSlackInboundGateway`), normalized from the Slack event format (channel ID, `ts` threading, `files` attachments) into a common `Ah5InboundEvent` structure.
- **Telegram** -- inbound messages are polled via a Telegram gateway (`startTelegramInboundGateway`), normalized from the Telegram update format (`chat.id`, `message_thread_id` threading, photo/document/video attachments) into the same `Ah5InboundEvent` structure.

On the outbound side, the channel detects the target type automatically. If the `to` address matches a Slack channel ID pattern (e.g., `C01ABC23DEF`), it routes through the Slack sub-provider; otherwise it routes through Telegram.

### Configuration

Enable the channel and its sub-providers in your OpenClaw Gateway config:

```json
{
  "channels": {
    "agenthifive": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "https://vault.example.com",
          "auth": {
            "mode": "agent",
            "agentId": "your-agent-id",
            "privateKey": "base64-encoded-ES256-JWK"
          },
          "providers": {
            "telegram": { "enabled": true, "dmPolicy": "balanced" },
            "slack": { "enabled": true }
          }
        }
      }
    }
  }
}
```

### Capabilities

The channel declares support for: `direct`, `group`, `channel`, and `thread` chat types, plus `reply`, `media`, `edit`, `unsend`, and `threads`. Streaming is blocked (`blockStreaming: true`) because vault-brokered delivery is request/response, not streamed.

## Background Approval Watcher

The plugin starts a background interval that polls the AgentHiFive Vault for pending step-up approvals. This ensures the agent is notified promptly when a user approves or denies a request, even if no new user message arrives.

### How it works

1. When a `vault_execute` call returns `approvalRequired: true`, the approval ID is stored in a local pending-approvals list (persisted to the state directory).
2. The background watcher polls `GET /v1/approvals/:id` for each pending approval at a configurable interval (default: 5 seconds via `WATCHER_POLL_MS`).
3. When an approval is resolved (approved, denied, expired, or consumed), the watcher removes it from the pending list and calls `wakeAgent()`.
4. `wakeAgent()` injects a system event into the agent's session via `enqueueSystemEvent()` and triggers an immediate heartbeat via `requestHeartbeatNow()`. This wakes the agent without waiting for the next user message.

### Session context

The plugin tracks the current session key via the `x-ah5-session-key` derived from `ctx.sessionKey` in the `before_agent_start` hook. The session key follows the format `agent:<agentId>:<sessionMainKey>` and is used to route wake events to the correct session. For channel sessions, the key also encodes the channel, peer ID, and peer kind so that approval resolutions reach the right conversation.

### LLM step-up approvals

For approvals triggered by LLM provider requests (where the URL starts with `llm://`), the watcher does **not** auto-wake the agent. These are replayed on the next real user turn to avoid silently consuming the approval before the user interacts.

## Hooks

### `before_agent_start`

The plugin registers multiple `before_agent_start` handlers at different priorities:

**Priority 10 -- Vault reference injection.** Writes chunked reference files to the state directory and returns an `appendSystemContext` string that tells the agent where to find them. The reference files contain:

- **Tool documentation** -- descriptions and parameter schemas for each vault tool.
- **Action templates per service** -- for each connected provider (e.g., Google, Microsoft, Notion), a set of pre-built action templates the agent can use as starting points for `vault_execute` calls.

If the state directory is unavailable, the plugin falls back to inline mode and builds the full API reference prompt in memory.

**Priority 5 -- Approval notifications.** Checks the pending-approvals list and appends a `<vault-approval-updates>` block listing any approvals that were resolved since the last agent turn.

**Priority 4 -- Channel lifecycle follow-up.** Consumes any queued channel lifecycle context (e.g., a Telegram or Slack action that required approval) and appends it to the system context so the agent can act on it.

### `llm_output`

The plugin also listens to `llm_output` events (priority 5) to detect when the LLM's response text contains an `approvalRequestId`. When found, it adds the approval to the pending list so the background watcher can track it.

## VaultActionProxy

The `VaultActionProxy` class is the core HTTP client that routes all tool calls and channel actions through the AgentHiFive Vault.

### Request flow

Every outbound API call goes through `POST /v1/vault/execute` on the vault. The proxy builds the request body with:

- `model: "B"` -- indicating brokered proxy semantics (Model B). The vault makes the provider API call on the agent's behalf, injecting the stored OAuth credential.
- `method`, `url`, `headers`, `body` -- the target provider API request.
- `service` or `connectionId` -- identifies which credential to use. `service` is for singleton services (e.g., `"telegram"`, `"slack"`); `connectionId` is for multi-account services (e.g., a specific Google connection).
- `approvalId` -- if retrying after a step-up approval, the approved request ID.
- `context` -- metadata for policy evaluation (tool name, action, channel).

### 401 retry behavior

If the vault returns HTTP 401 (token expired), the proxy calls `onTokenRefresh()` to trigger a single token refresh via the `VaultTokenManager`. If the refresh succeeds, the request is retried exactly once. If the retry also returns 401, the proxy returns a structured error with a `blocked.hint` explaining that the vault connection is broken and the admin needs to generate a new bootstrap secret.

### Step-up approval handling

When the vault returns HTTP 202 with `approvalRequired: true`, the proxy returns a `ProxyResponse` with `blocked.policy` set to `"step-up-approval"` and `blocked.approvalRequestId` set to the approval ID. The calling tool (or channel outbound handler) can then:

1. Store the approval ID in the pending-approvals list for background tracking.
2. Return the approval ID to the agent so it can later retry with `approvalId`.
3. Wait for the background watcher to notify the agent when the approval resolves.

### Policy blocks and errors

- **Policy block** (`blocked` in response body) -- returned when the vault's allowlist or rate limiter rejects the request.
- **HTTP 403** -- returned when vault policy explicitly denies the request.
- **Non-JSON responses** -- the proxy throws an error with a preview of the response body for debugging.

## Installation

```bash
openclaw plugins install @agenthifive/agenthifive
```

Or add it to your `package.json` directly:

```bash
npm install @agenthifive/agenthifive
```

## Configuration

Configure the plugin in your OpenClaw Gateway config under `plugins.entries.agenthifive.config`:

```json
{
  "plugins": {
    "entries": {
      "agenthifive": {
        "config": {
          "baseUrl": "https://vault.example.com",
          "auth": {
            "mode": "agent",
            "agentId": "your-agent-id",
            "privateKey": "base64-encoded-ES256-JWK"
          },
          "pollTimeoutMs": 300000,
          "pollIntervalMs": 3000
        }
      }
    }
  }
}
```

### Configuration reference

The plugin accepts an `OpenClawPluginConfig` object with the following fields:

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseUrl` | `string` | No | `https://app.agenthifive.com` | AgentHiFive Vault API base URL |
| `auth` | `OpenClawAuthConfig` | Yes | -- | Authentication configuration (see below) |
| `debugLevel` | `string` | No | -- | Logging verbosity: `"silent"`, `"error"`, `"warn"`, `"info"`, or `"debug"` |
| `pollTimeoutMs` | `number` | No | `300000` (5 min) | Default timeout for polling operations (e.g., approval wait) |
| `pollIntervalMs` | `number` | No | `3000` (3 sec) | Interval between poll requests for approval status |
| `connectedProviders` | `string[]` | No | `[]` | List of connected provider names for prompt injection (e.g., `["google", "microsoft", "notion"]`) |

### Authentication modes

The `auth` field accepts one of two modes:

**Agent authentication (ES256 JWT):**

```json
{
  "mode": "agent",
  "agentId": "your-agent-id",
  "privateKey": "base64-encoded-ES256-JWK",
  "tokenAudience": "https://app.agenthifive.com"
}
```

The `privateKey` is a base64-encoded ES256 JWK private key. The optional `tokenAudience` overrides the JWT audience claim (defaults to `baseUrl`).

**Bearer token authentication:**

```json
{
  "mode": "bearer",
  "token": "your-bearer-token"
}
```

:::warning
Store private keys and bearer tokens securely. Use OpenClaw's secret storage conventions or environment variables rather than hardcoding credentials in config files.
:::

## Programmatic usage

The plugin exports a `register()` function that OpenClaw calls at startup. You can also call it directly if you are composing plugins programmatically:

```typescript
import { registerAgentHiFivePlugin } from "@agenthifive/agenthifive";

// The `api` object is provided by the OpenClaw plugin loader.
// When called manually, supply at minimum `pluginConfig` and `registerTool`.
registerAgentHiFivePlugin({
  pluginConfig: {
    baseUrl: "https://vault.example.com",
    auth: { mode: "agent", agentId: process.env.AGENT_ID!, privateKey: JSON.parse(process.env.AGENT_PRIVATE_KEY!) },
  },
  registerTool(tool) {
    console.log("Registered:", tool.name);
  },
  logger: console,
  on(_event, _handler, _opts) { /* hook registration */ },
});
```

## Tools reference

The plugin registers six tools.

---

### `vault_execute`

Execute an HTTP request through the AgentHiFive Vault proxy (Model B). The Vault handles authentication, policy enforcement, allowlist checking, and audit logging. The agent never sees provider credentials. Use `service` for singleton services (Telegram, Anthropic) or `connectionId` for multi-account services (Google, Microsoft).

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | No | The connection ID to use (for multi-account services like Google, Microsoft). Either `connectionId` or `service` must be provided. |
| `service` | `string` | No | Service name for singleton services (e.g., `"telegram"`, `"slack"`, `"anthropic-messages"`). Either `connectionId` or `service` must be provided. |
| `method` | `string` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `url` | `string` | Yes | Target URL for the provider API |
| `query` | `object` | No | Query parameters as key-value pairs |
| `headers` | `object` | No | Additional headers (`Authorization` is injected by the Vault) |
| `body` | `object` | No | Request body (for `POST`, `PUT`, `PATCH`) |
| `approvalId` | `string` | No | Approval request ID to bypass a `require_approval` guard (from a previous 202 response) |

**Response (success):**

```typescript
{
  status: 200,
  headers: { "content-type": "application/json" },
  body: { /* provider API response */ },
  auditId: "aud_abc123"
}
```

**Response (approval required):**

If the request triggers a step-up approval (e.g., a write operation under `risk_based` approval mode), the response indicates this instead of executing immediately:

```typescript
{
  approvalRequired: true,
  approvalRequestId: "apr_xyz789",
  auditId: "aud_abc123"
}
```

**Example -- search Gmail (agent calls `vault_execute`):**

```json
{
  "connectionId": "conn_gmail_01",
  "method": "GET",
  "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  "query": { "q": "from:alice@example.com", "maxResults": "10" }
}
```

---

### `request_permission`

Create a step-up approval request for a sensitive action. The user must approve via the AgentHiFive dashboard before the action executes.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | Yes | The connection ID for this action |
| `actionDescription` | `string` | Yes | Human-readable description of the action |
| `method` | `string` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `url` | `string` | Yes | Target URL for the action |
| `body` | `object` | No | Request body for the action |

**Response:**

```typescript
{
  approvalRequestId: "apr_xyz789",
  auditId: "aud_abc123"
}
```

**Example -- send an email (request approval, agent calls `request_permission`):**

```json
{
  "connectionId": "conn_gmail_01",
  "actionDescription": "Send email to bob@example.com: Q3 Report",
  "method": "POST",
  "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  "body": { "raw": "base64-encoded-email-content" }
}
```

---

### `request_capability`

Request access to a new service or capability from the workspace owner. Use when the user asks about a vault-supported service that has no active connection. The workspace owner will see the request in the AgentHiFive dashboard and can connect the service and approve access.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `actionTemplateId` | `string` | Yes | Action template ID from the vault reference (e.g., `"telegram"`, `"gmail-manage"`, `"notion-read"`) |
| `reason` | `string` | Yes | Why the agent needs this capability (e.g., `"User wants to send Telegram messages"`) |

**Response:**

```typescript
{
  success: true,
  requestId: "req_abc123",
  actionTemplateId: "telegram",
  message: "Permission request submitted. The workspace owner will be notified in the AgentHiFive dashboard. They need to approve the request and connect the service."
}
```

---

### `vault_await_approval`

Wait for a step-up approval request to be resolved. Blocks (via polling) until the user approves, denies, or the request expires. This is a fallback tool -- the system auto-notifies the agent when approvals resolve, so only use this if the user explicitly asks to wait inline.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `approvalRequestId` | `string` | Yes | The approval request ID from `vault_execute` or `request_permission` |
| `timeoutMs` | `number` | No | Timeout in milliseconds (default: `300000` = 5 min) |

**Response (approved):**

```typescript
{
  status: 200,
  headers: {},
  body: { message: "Approval was granted and executed via dashboard" },
  auditId: "aud_def456"
}
```

**Error conditions:**

- Throws if the approval is **denied** by the user.
- Throws if the approval **expires** before the user acts.
- Throws if polling **times out** (exceeds `timeoutMs`).

**Example -- complete the send-email flow (agent calls `vault_await_approval`):**

```json
{
  "approvalRequestId": "apr_xyz789"
}
```

---

### `vault_connections_list`

List all connections in the current workspace. Returns provider type, label, status, granted scopes, and creation date for each connection.

**Parameters:** None.

**Response:**

```typescript
{
  connections: [
    {
      id: "conn_gmail_01",
      provider: "google",
      label: "Personal Gmail",
      status: "healthy",
      grantedScopes: ["gmail.readonly", "calendar.readonly"],
      createdAt: "2026-01-15T10:30:00Z"
    }
  ]
}
```

---

### `vault_connection_revoke`

Immediately revoke a connection. This blocks all future token vending and API execution through this connection. The action is irreversible.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | Yes | The connection ID to revoke |

**Response:**

```typescript
{
  revoked: true,
  connectionId: "conn_gmail_01",
  auditId: "aud_ghi789"
}
```

:::warning
Revoking a connection is permanent. Any skills or automations that depend on this connection will stop working immediately.
:::

## End-to-end example: high-five approval flow

This example shows the full flow for a write operation that requires user approval. The agent calls these tools sequentially through the Gateway:

**Step 1 -- Agent calls `vault_execute`** (Vault may require approval for writes):

```json
{
  "connectionId": "conn_gmail_01",
  "method": "POST",
  "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
  "body": { "raw": "base64-encoded-email" }
}
```

**Step 2 -- If the response indicates `approvalRequired: true`**, the agent calls `vault_await_approval` (or waits for the system auto-notification):

```json
{
  "approvalRequestId": "apr_xyz789",
  "timeoutMs": 120000
}
```

**Step 3 -- Once approved**, the agent receives the execution result with `auditId` confirming the action was carried out.

## Type reference

The full TypeScript types are exported from the package for use in custom integrations:

```typescript
import type {
  OpenClawPluginConfig,
  OpenClawAuthConfig,
  VaultDebugLevel,
  ExecuteInput,
  ExecuteOutput,
  ExecuteApprovalOutput,
  ApprovalRequestInput,
  ApprovalRequestOutput,
  ApprovalCommitInput,
  ApprovalCommitOutput,
  ConnectionListItem,
  ConnectionsListOutput,
  ConnectionRevokeInput,
  ConnectionRevokeOutput,
} from "@agenthifive/agenthifive";
```
