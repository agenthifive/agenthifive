---
title: Gateway Plugin Guide
sidebar_position: 2
sidebar_label: Plugin Guide
description: Install, configure, and use the @agenthifive/openclaw Gateway plugin to give OpenClaw agents secure access to provider APIs.
---

# Gateway Plugin Guide

The `@agenthifive/openclaw` package is a first-class OpenClaw Gateway plugin that registers five `agenthifive.*` tools. The plugin runs in-process with the Gateway (trusted boundary) and communicates with the AgentHiFive Vault to execute provider API calls, manage connections, and enforce step-up approvals.

:::tip Key invariant
The plugin stores only Vault session credentials and connection IDs. Provider refresh tokens are **never** stored on the OpenClaw host.
:::

## Installation

```bash
openclaw plugins install @agenthifive/openclaw
```

Or add it to your `package.json` directly:

```bash
npm install @agenthifive/openclaw
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
            "mode": "api_key",
            "apiKey": "your-vault-api-key"
          },
          "pollTimeoutMs": 300000,
          "pollIntervalMs": 5000
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
| `baseUrl` | `string` | Yes | -- | AgentHiFive Vault API base URL (e.g., `https://vault.example.com`) |
| `auth` | `OpenClawAuthConfig` | Yes | -- | Authentication configuration (see below) |
| `pollTimeoutMs` | `number` | No | `300000` (5 min) | Default timeout for polling operations (e.g., approval wait) |
| `pollIntervalMs` | `number` | No | `5000` (5 sec) | Interval between poll requests for approval status |

### Authentication modes

The `auth` field accepts one of two modes:

**API key authentication:**

```json
{
  "mode": "api_key",
  "apiKey": "your-vault-api-key"
}
```

**Bearer token authentication:**

```json
{
  "mode": "bearer",
  "token": "your-bearer-token"
}
```

:::warning
Store API keys and bearer tokens securely. Use OpenClaw's secret storage conventions or environment variables rather than hardcoding credentials in config files.
:::

## Programmatic usage

You can also instantiate the plugin directly in TypeScript:

```typescript
import { AgentHiFivePlugin } from "@agenthifive/openclaw";

const plugin = new AgentHiFivePlugin({
  baseUrl: "https://vault.example.com",
  auth: { mode: "api_key", apiKey: process.env.VAULT_API_KEY! },
});

// Get all tool definitions for Gateway registration
const tools = plugin.getTools();

// Get the plugin manifest
const manifest = plugin.manifest();
// => { name: "agenthifive", version: "0.1.0", tools: [...] }
```

## Tools reference

The plugin registers five tools. Each tool is prefixed with `agenthifive.` in the Gateway.

---

### `agenthifive.execute`

Execute an HTTP request through the AgentHiFive Vault proxy (Model B). The Vault handles authentication, policy enforcement, allowlist checking, and audit logging. The agent never sees provider credentials.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | Yes | The connection ID to use for this request |
| `method` | `string` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `url` | `string` | Yes | Target URL for the provider API |
| `query` | `object` | No | Query parameters as key-value pairs |
| `headers` | `object` | No | Additional headers (`Authorization` is injected by the Vault) |
| `body` | `object` | No | Request body (for `POST`, `PUT`, `PATCH`) |

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

**Example -- search Gmail:**

```typescript
const result = await plugin.getTools()
  .find(t => t.name === "agenthifive.execute")!
  .execute({
    connectionId: "conn_gmail_01",
    method: "GET",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    query: { q: "from:alice@example.com", maxResults: "10" },
  });
```

---

### `agenthifive.request_permission`

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

**Example -- send an email (request approval):**

```typescript
const approval = await plugin.getTools()
  .find(t => t.name === "agenthifive.request_permission")!
  .execute({
    connectionId: "conn_gmail_01",
    actionDescription: "Send email to bob@example.com: Q3 Report",
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    body: { raw: "base64-encoded-email-content" },
  });
```

---

### `agenthifive.vault_await_approval`

Wait for a step-up approval request to be resolved. Blocks (via polling) until the user approves, denies, or the request expires.

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `approvalRequestId` | `string` | Yes | The approval request ID from `request_permission` or `execute` |
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

**Example -- complete the send-email flow:**

```typescript
// After request_permission returned approvalRequestId
const result = await plugin.getTools()
  .find(t => t.name === "agenthifive.vault_await_approval")!
  .execute({
    approvalRequestId: "apr_xyz789",
  });
```

---

### `agenthifive.connections_list`

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

### `agenthifive.connection_revoke`

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

This example shows the full flow for a write operation that requires user approval:

```typescript
import { AgentHiFivePlugin } from "@agenthifive/openclaw";

const plugin = new AgentHiFivePlugin({
  baseUrl: process.env.VAULT_URL!,
  auth: { mode: "api_key", apiKey: process.env.VAULT_API_KEY! },
});

// 1. Try to execute -- Vault may require approval for writes
const execResult = await plugin.getTools()
  .find(t => t.name === "agenthifive.execute")!
  .execute({
    connectionId: "conn_gmail_01",
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    body: { raw: "base64-encoded-email" },
  });

// 2. Check if approval is required
if (execResult.approvalRequired) {
  console.log("Waiting for user approval on the AgentHiFive dashboard...");

  // 3. Poll until user approves (or denies/expires)
  const commitResult = await plugin.getTools()
    .find(t => t.name === "agenthifive.vault_await_approval")!
    .execute({
      approvalRequestId: execResult.approvalRequestId,
      timeoutMs: 120000, // 2 minute timeout
    });

  console.log("Action approved and executed:", commitResult.auditId);
} else {
  console.log("Action executed directly:", execResult.auditId);
}
```

## Type reference

The full TypeScript types are exported from the package for use in custom integrations:

```typescript
import type {
  OpenClawPluginConfig,
  OpenClawAuthConfig,
  OpenClawToolDefinition,
  OpenClawToolParameter,
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
} from "@agenthifive/openclaw";
```
