---
title: MCP Server
sidebar_position: 3
sidebar_label: MCP Server
description: Run the AgentHiFive MCP server to expose Vault tools to Claude Code, OpenClaw via mcporter, and other MCP-compatible clients.
---

# MCP Server

The `agenthifive-mcp` package is a standalone MCP (Model Context Protocol) server that exposes AgentHiFive Vault tools over stdio transport. It lets any MCP-compatible client -- Claude Code, OpenClaw via mcporter, OpenCode, and others -- execute provider API calls, list connections, and revoke access through the Vault.

:::info When to use this vs. the Gateway Plugin
The [Gateway Plugin](./plugin-guide.md) is the recommended integration for OpenClaw. Use the MCP server when you need portability across multiple agent clients, or when your setup does not use the OpenClaw Gateway directly.
:::

## Installation

```bash
npm install -g agenthifive-mcp
```

Or run directly with `npx`:

```bash
npx agenthifive-mcp
```

## Configuration

The MCP server reads all configuration from environment variables.

### Authentication variables

The MCP server supports two authentication modes. Provide one of the following:

**Option 1: Agent private key (recommended)**

| Variable | Description |
|---|---|
| `AGENTHIFIVE_BASE_URL` | AgentHiFive Vault API base URL (e.g., `https://vault.example.com`) |
| `AGENTHIFIVE_AGENT_ID` | Agent ID (UUID) |
| `AGENTHIFIVE_PRIVATE_KEY_PATH` | Path to a JSON file containing the ES256 private key JWK |

Or provide the key inline as base64-encoded JSON:

| Variable | Description |
|---|---|
| `AGENTHIFIVE_PRIVATE_KEY` | Base64-encoded JSON of the ES256 private key JWK |

**Option 2: Bearer token (for testing or PATs)**

| Variable | Description |
|---|---|
| `AGENTHIFIVE_BASE_URL` | AgentHiFive Vault API base URL |
| `AGENTHIFIVE_BEARER_TOKEN` | Direct bearer token (`ah5t_`, `ah5p_`, or JWT) |

### Optional variables

| Variable | Default | Description |
|---|---|---|
| `AGENTHIFIVE_TOKEN_AUDIENCE` | `AGENTHIFIVE_BASE_URL` | `aud` claim for client assertions |
| `AGENTHIFIVE_POLL_TIMEOUT_MS` | `300000` (5 min) | Timeout for approval polling operations |
| `AGENTHIFIVE_POLL_INTERVAL_MS` | `5000` (5 sec) | Interval between approval status poll requests |

:::warning
At least one authentication method must be configured. The server will exit with an error if no credentials are provided.
:::

## Running the server

### Direct execution

```bash
export AGENTHIFIVE_BASE_URL="https://vault.example.com"
export AGENTHIFIVE_AGENT_ID="your-agent-id"
export AGENTHIFIVE_PRIVATE_KEY_PATH="/path/to/agent-key.json"
npx agenthifive-mcp
```

The server communicates over stdio (stdin/stdout), which is the standard MCP transport for local tool servers.

### With Claude Code

Add the server to your Claude Code MCP configuration (`.claude/mcp.json` or the project-level equivalent):

```json
{
  "mcpServers": {
    "agenthifive": {
      "command": "npx",
      "args": ["agenthifive-mcp"],
      "env": {
        "AGENTHIFIVE_BASE_URL": "https://vault.example.com",
        "AGENTHIFIVE_AGENT_ID": "your-agent-id",
        "AGENTHIFIVE_PRIVATE_KEY_PATH": "/path/to/agent-key.json"
      }
    }
  }
}
```

Once configured, Claude Code will discover all seven tools (`execute`, `list_connections`, `revoke`, `list_services`, `get_my_capabilities`, `request_capability`, and `list_approvals`) automatically.

### With OpenClaw via mcporter

OpenClaw can consume MCP tools through mcporter. Add the AgentHiFive MCP server:

```bash
mcporter add agenthifive --npm agenthifive-mcp
```

Then configure the environment variables in your mcporter config or shell environment.

### With other MCP clients

Any client that supports the MCP stdio transport can connect. Point it at the `agenthifive-mcp` binary and provide the required environment variables.

## Available tools

The MCP server exposes seven tools. These mirror a subset of the [Gateway Plugin tools](./plugin-guide.md#tools-reference) with MCP-native input schemas (Zod-based).

---

### `execute`

Execute an HTTP request through the AgentHiFive Vault proxy (Model B). The Vault handles authentication, policy enforcement, allowlist checking, rate limiting, and audit logging. The agent never sees provider credentials.

If the action requires step-up approval, the response will indicate this and the user should approve via the AgentHiFive dashboard.

**Input schema:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | No | Connection ID (required for multi-account services like Google/Microsoft). Use `list_connections` to find IDs. |
| `service` | `string` | No | Service ID for singleton services (e.g., `telegram`). Use instead of `connectionId` for single-account services. |
| `method` | `enum` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `url` | `string` | Yes | Target URL for the provider API |
| `query` | `Record<string, string>` | No | Query parameters as key-value pairs |
| `headers` | `Record<string, string>` | No | Additional headers (`Authorization` is injected by the Vault) |
| `body` | `unknown` | No | Request body (for `POST`, `PUT`, `PATCH`) |
| `approvalId` | `string` | No | Approval request ID from a previously approved step-up request. When provided, the vault verifies the approval and skips the `require_approval` guard. Get this from the `approvalRequestId` field of a 202 response, after the user approves it. |

**Example response (success):**

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": { "messages": ["..."] },
  "auditId": "aud_abc123"
}
```

**Example response (approval required):**

```json
{
  "approvalRequired": true,
  "approvalRequestId": "apr_xyz789",
  "auditId": "aud_abc123"
}
```

---

### `list_connections`

List all connected provider accounts in the current workspace. Shows provider type, label, status (`healthy`, `needs_reauth`, `revoked`), granted scopes, and creation date for each connection.

**Input schema:** None (no parameters).

**Example response:**

```json
{
  "connections": [
    {
      "id": "conn_gmail_01",
      "provider": "google",
      "label": "Personal Gmail",
      "status": "healthy",
      "grantedScopes": ["gmail.readonly", "calendar.readonly"],
      "createdAt": "2026-01-15T10:30:00Z"
    }
  ]
}
```

---

### `revoke`

Immediately revoke a connection, blocking all future token vending and API execution through it. This action is immediate and cannot be undone. Returns a confirmation with an audit trail ID.

**Input schema:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `connectionId` | `string` | Yes | The ID of the connection to revoke |

**Example response:**

```json
{
  "revoked": true,
  "connectionId": "conn_gmail_01",
  "auditId": "aud_ghi789"
}
```

### `list_services`

Discover all services available on AgentHiFive (Gmail, Calendar, Drive, Teams, Outlook, Telegram). Returns each service with its action templates (e.g., `gmail-read`, `gmail-send`). Use this to understand what capabilities can be requested.

**Input schema:** None (no parameters).

---

### `get_my_capabilities`

Check what services and actions the agent currently has access to. Returns active connections (already granted), pending requests (awaiting approval), and available actions (can be requested). Use this before requesting new capabilities.

**Input schema:** None (no parameters).

---

### `request_capability`

Request access to a specific service action (e.g., `gmail-read` to read emails). The workspace owner will be notified and can approve via the AgentHiFive dashboard. Returns 409 if a request already exists or access is already granted. Use `list_services` to find valid action template IDs.

**Input schema:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `actionTemplateId` | `string` | Yes | The action template ID to request (e.g., `gmail-read`, `teams-manage`) |
| `reason` | `string` | Yes | Explain why the agent needs this capability (shown to the user) |

---

### `list_approvals`

List step-up approval requests for the current workspace. Use this after an `execute` call returns `approvalRequired=true` to check if the user has approved your request. When status is `approved`, re-submit the original request with the `approvalId` to execute it.

**Input schema:** None (no parameters).

---

## Architecture

```
MCP Client (Claude Code, mcporter, etc.)
    |
    | stdio (stdin/stdout)
    |
agenthifive-mcp server
    |
    | HTTPS (agent access token or bearer token)
    |
AgentHiFive Vault
    |
    | OAuth2 (refresh tokens stored here)
    |
Provider APIs (Google, Microsoft, Slack, ...)
```

The MCP server is a thin layer that translates MCP tool calls into Vault API requests using the same `VaultClient` from the `@agenthifive/agenthifive` package. No provider credentials pass through the MCP server or the client.

## Error handling

The MCP server surfaces errors as MCP tool response text. Common error scenarios:

| Scenario | Behavior |
|---|---|
| Missing environment variables | Server exits immediately with a descriptive error on stderr |
| Vault API unreachable | Tool call returns an error response |
| Connection not found | Tool call returns an error response |
| Approval denied or expired | Tool call returns an error describing the denial/expiry |

Errors are written to stderr and will appear in the MCP client's server logs.

## Differences from the Gateway Plugin

| Feature | Gateway Plugin | MCP Server |
|---|---|---|
| Transport | In-process (Gateway) | stdio (MCP) |
| Tools | 6 (`vault_execute`, `request_permission`, `request_capability`, `vault_await_approval`, `vault_connections_list`, `vault_connection_revoke`) | 7 (`execute`, `list_connections`, `revoke`, `list_services`, `get_my_capabilities`, `request_capability`, `list_approvals`) |
| Approval flow | Built-in polling via `vault_await_approval` (fallback) or auto-notification | Indicated in `execute` response; user approves via dashboard |
| Best for | OpenClaw Gateway deployments | Cross-client portability (Claude Code, mcporter, etc.) |
