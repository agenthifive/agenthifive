---
title: SDK Guide
sidebar_position: 1
sidebar_label: Overview
description: Install and get started with the AgentHiFive TypeScript SDK for authority delegation.
---

# SDK Guide

The `@agenthifive/sdk` package is the official TypeScript client for the AgentHiFive authority delegation platform. It provides a typed, ergonomic interface for managing OAuth connections, executing requests through the gateway, handling step-up approvals, and querying audit logs.

## What the SDK Provides

- **Connection management** -- start OAuth flows, list connections, revoke access.
- **Execution gateway** -- call provider APIs via Model A (token vending) or Model B (brokered proxy).
- **Step-up approvals** -- list, approve, or deny pending approval requests.
- **Agent and policy management** -- register agents, create policy bindings.
- **Audit log access** -- query audit events with filters and cursor pagination.
- **Full TypeScript types** -- re-exports core types from `@agenthifive/contracts`.

## Installation

```bash
npm install @agenthifive/sdk
# or
pnpm add @agenthifive/sdk
```

:::info Requirements
The SDK requires **Node.js 18+** (uses the built-in `fetch` API) and **TypeScript 5.6+** for development.
:::

## Quick Start

### Agent Authentication (recommended for AI agents)

```typescript
import { AgentHiFiveClient } from "@agenthifive/sdk";

// First-time bootstrap (run once with the bootstrap secret from the dashboard)
const { client, agentId } = await AgentHiFiveClient.bootstrap({
  baseUrl: "https://api.agenthifive.com",
  bootstrapSecret: "ah5b_...",
});

// After bootstrap, create the client with the persisted private key
const client = new AgentHiFiveClient({
  baseUrl: "https://api.agenthifive.com",
  privateKey: savedPrivateKeyJwk,
  agentId: "your-agent-id",
});

// The SDK handles token refresh automatically
const result = await client.execute({
  model: "B",
  connectionId: "your-connection-id",
  method: "GET",
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  query: { maxResults: "10" },
});

if ("approvalRequired" in result) {
  console.log("Approval needed:", result.approvalRequestId);
} else if (result.model === "B") {
  console.log("Response:", result.body);
  console.log("Audit ID:", result.auditId);
}
```

### Bearer Token (for PATs, testing, or dashboard-issued JWTs)

```typescript
const client = new AgentHiFiveClient({
  baseUrl: "https://api.agenthifive.com",
  bearerToken: "ah5p_your_personal_access_token",
});

const connections = await client.listConnections();
```

## Execution Models

AgentHiFive supports two execution models for calling provider APIs:

| Model | Name | How It Works |
|-------|------|--------------|
| **A** | Token Vending | Returns a short-lived access token for the agent to call the provider API directly. |
| **B** | Brokered Proxy | AgentHiFive executes the HTTP request on the agent's behalf. The agent never sees the credentials. |

## Next Steps

- [Client Reference](./client-reference.md) -- full API reference for `AgentHiFiveClient`.
- [Error Handling](./error-handling.md) -- working with `AgentHiFiveError` and retry logic.
- [TypeScript Types](./typescript-types.md) -- types re-exported from `@agenthifive/contracts`.
