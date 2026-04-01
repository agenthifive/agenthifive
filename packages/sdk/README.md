# @agenthifive/sdk

Official TypeScript SDK for the [AgentHiFive](https://github.com/AgentHiFive) authority delegation platform.

## Installation

```bash
npm install @agenthifive/sdk
# or
pnpm add @agenthifive/sdk
```

## Quick Start

```typescript
import { AgentHiFiveClient } from "@agenthifive/sdk";

const client = new AgentHiFiveClient({
  baseUrl: "https://api.agenthifive.com",
  apiKey: "ah5_your_api_key",
});
```

## Usage

### List Connections

```typescript
const connections = await client.listConnections();
for (const conn of connections) {
  console.log(`${conn.provider}: ${conn.label} (${conn.status})`);
}
```

### Execute via Model B (Brokered Proxy)

Execute HTTP requests through AgentHiFive without receiving provider credentials:

```typescript
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

### Execute via Model A (Token Vending)

Request a short-lived access token to call provider APIs directly:

```typescript
const result = await client.execute({
  model: "A",
  connectionId: "your-connection-id",
});

if (result.model === "A") {
  // Use the token to call the provider API directly
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
    headers: { Authorization: `Bearer ${result.accessToken}` },
  });
}
```

### Handle Step-Up Approvals

```typescript
// List pending approvals
const approvals = await client.listApprovals();

// Approve an action (executes the original request)
const execResult = await client.approveAction(approvals[0].id);

// Or deny it
const denyResult = await client.denyAction(approvals[0].id);
```

### Start a Connection (OAuth Flow)

```typescript
// Start auth code flow — returns authorization URL for browser redirect
const connectResult = await client.connect("google", {
  label: "My Gmail",
});

// Redirect user to authorizationUrl in the browser
console.log("Authorize at:", connectResult.authorizationUrl);
// The callback will finalize the connection automatically
```

### Revoke a Connection

```typescript
const { auditId } = await client.revokeConnection("connection-id");
console.log("Revoked. Audit ID:", auditId);
```

### Audit Events

```typescript
const { events, nextCursor } = await client.listAuditEvents({
  action: "execution_completed",
  limit: 20,
});

for (const event of events) {
  console.log(`${event.timestamp}: ${event.action} - ${event.decision}`);
}
```

### Error Handling

```typescript
import { AgentHiFiveError } from "@agenthifive/sdk";

try {
  await client.execute({ model: "B", connectionId: "id", method: "GET", url: "..." });
} catch (err) {
  if (err instanceof AgentHiFiveError) {
    console.error(`Error ${err.statusCode}: ${err.message}`);
    if (err.auditId) console.error("Audit ID:", err.auditId);
    if (err.retryAfter) console.error("Retry after:", err.retryAfter, "seconds");
  }
}
```

## API Reference

### `AgentHiFiveClient`

| Method | Description |
|--------|-------------|
| `connect(provider, options?)` | Start OAuth connection flow (auth code with PKCE) |
| `listConnections()` | List all workspace connections |
| `revokeConnection(connectionId)` | Revoke a connection |
| `execute(options)` | Execute via Model A or B |
| `listApprovals()` | List pending approval requests |
| `approveAction(approvalRequestId)` | Approve and execute a pending action |
| `denyAction(approvalRequestId)` | Deny a pending action |
| `listAgents()` | List workspace agents |
| `createAgent(options)` | Register a new agent |
| `listPolicies()` | List workspace policies |
| `createPolicy(options)` | Create a policy binding |
| `listAuditEvents(options?)` | List audit events with filters |

### `AgentHiFiveError`

Thrown on API errors. Properties:

- `statusCode` — HTTP status code
- `message` — Error message from the API
- `auditId` — Audit trail ID (when available)
- `retryAfter` — Seconds until retry is allowed (on 429)

## TypeScript Types

The SDK re-exports commonly used types from `@agenthifive/contracts`:

```typescript
import type {
  Connection,
  ConnectionStatus,
  OAuthProvider,
  Agent,
  Policy,
  ExecutionModel,
  DefaultMode,
  StepUpApproval,
  AllowlistEntry,
  RateLimit,
  TimeWindow,
  AuditEvent,
} from "@agenthifive/sdk";
```

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- TypeScript 5.6+ (for development)
