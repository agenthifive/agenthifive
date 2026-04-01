---
title: Client Reference
sidebar_position: 2
sidebar_label: Client Reference
description: Full API reference for the AgentHiFiveClient class, including constructor options, methods, and usage examples.
---

# Client Reference

The `AgentHiFiveClient` class is the primary entry point for interacting with the AgentHiFive API.

## Constructor

The client supports two authentication modes:

### Agent Authentication (private key)

```typescript
import { AgentHiFiveClient } from "@agenthifive/sdk";

const client = new AgentHiFiveClient({
  baseUrl: "https://api.agenthifive.com",
  privateKey: { kty: "EC", crv: "P-256", x: "...", y: "...", d: "..." },
  agentId: "your-agent-id",
});
```

The SDK automatically signs ES256 client assertions and exchanges them for short-lived access tokens. Tokens are refreshed 30 seconds before expiry.

### Bearer Token (PATs, JWTs, testing)

```typescript
const client = new AgentHiFiveClient({
  baseUrl: "https://api.agenthifive.com",
  bearerToken: "ah5p_your_personal_access_token",
});
```

### `AgentHiFiveClientConfig`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `baseUrl` | `string` | Yes | Base URL of the AgentHiFive API. Trailing slashes are stripped automatically. |
| `privateKey` | `JWK` | No | ES256 private key in JWK format. Used with `agentId` for agent auth. |
| `agentId` | `string` | No | Agent ID. Required when using `privateKey`. |
| `tokenAudience` | `string` | No | `aud` claim for client assertions. Defaults to `baseUrl`. |
| `bearerToken` | `string` | No | Direct bearer token (PAT, JWT, or `ah5t_` access token). |

You must provide either `privateKey` + `agentId` or `bearerToken`.

## Static Methods

### `AgentHiFiveClient.bootstrap(baseUrl, bootstrapSecret, publicKey)`

Bootstrap an agent: registers or rotates the ES256 public key using a one-time bootstrap secret. Works for both first enrollment (`created` → `active`) and key rotation (`active` → replace key + invalidate tokens).

```typescript
const result = await AgentHiFiveClient.bootstrap(
  "https://api.agenthifive.com",
  "ah5b_...",
  publicKeyJwk,
);

console.log("Agent ID:", result.agentId);
console.log("Status:", result.status); // "active"
```

Returns: `BootstrapResult` — `{ agentId: string, name: string, status: AgentStatus, workspaceId: string }`

## Methods

### Connection Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `connect(provider, options?)` | `ConnectStartResult` | Start an OAuth authorization code flow. Returns an `authorizationUrl` for browser redirect. |
| `listConnections()` | `ConnectionSummary[]` | List all connections in the current workspace. |
| `revokeConnection(connectionId)` | `{ revoked, auditId }` | Revoke a connection immediately. Blocks all future token vending and execution. |

#### Start a Connection

```typescript
const result = await client.connect("google", {
  label: "My Gmail",
  scopes: ["gmail.readonly"],
});

// Redirect user to this URL in the browser
console.log("Authorize at:", result.authorizationUrl);
```

#### Revoke a Connection

```typescript
const { auditId } = await client.revokeConnection("connection-id");
console.log("Revoked. Audit ID:", auditId);
```

### Execution Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `execute({ model: "A", connectionId })` | `ExecuteResult` | Request a short-lived access token (Model A). |
| `execute({ model: "B", connectionId, method, url, ... })` | `ExecuteResult` | Execute an HTTP request through the brokered proxy (Model B). |

The return type is a discriminated union. Check the `model` property or the presence of `approvalRequired` to determine the result type.

#### Model A (Token Vending)

```typescript
const result = await client.execute({
  model: "A",
  connectionId: "your-connection-id",
});

if (result.model === "A") {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
    headers: { Authorization: `Bearer ${result.accessToken}` },
  });
}
```

#### Model B (Brokered Proxy)

```typescript
const result = await client.execute({
  model: "B",
  connectionId: "your-connection-id",
  method: "GET",
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  query: { maxResults: "10" },
});

if (result.model === "B") {
  console.log("Status:", result.status);
  console.log("Body:", result.body);
}
```

### Approval Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `listApprovals()` | `ApprovalRequest[]` | List pending approval requests for the workspace. |
| `approveAction(approvalRequestId)` | `ExecuteModelBResult` | Approve and execute a pending action. |
| `denyAction(approvalRequestId)` | `{ denied, approvalRequestId, auditId }` | Deny a pending action. |

```typescript
const approvals = await client.listApprovals();

// Approve the first pending request
const execResult = await client.approveAction(approvals[0].id);

// Or deny it
const denyResult = await client.denyAction(approvals[0].id);
```

### Agent Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `listAgents()` | `AgentSummary[]` | List agents in the current workspace. Each includes `status` and `enrolledAt`. |
| `createAgent(options)` | `CreateAgentResult` | Register a new agent. Returns a bootstrap secret (`ah5b_` prefix). |

### Policy Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `listPolicies()` | `PolicySummary[]` | List policies in the current workspace. |
| `createPolicy(options)` | `PolicySummary` | Create a policy binding between an agent and a connection. |

### Audit Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `listAuditEvents(options?)` | `AuditListResult` | List audit events with optional filters and cursor pagination. |

#### Filtering Audit Events

```typescript
const { events, nextCursor } = await client.listAuditEvents({
  action: "execution_completed",
  agentId: "agent-uuid",
  dateFrom: "2026-01-01",
  limit: 20,
});

for (const event of events) {
  console.log(`${event.timestamp}: ${event.action} - ${event.decision}`);
}
```
