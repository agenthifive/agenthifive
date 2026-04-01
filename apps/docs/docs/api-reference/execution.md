---
title: Execution
sidebar_position: 4
sidebar_label: Execution
description: Execution gateway endpoints -- Model A token vending, Model B brokered proxy, and credential resolution.
---

# Execution

The execution gateway is the core of AgentHiFive. It provides two execution models for agents to interact with provider APIs, plus a credential resolution endpoint for external agent frameworks.

## Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/vault/execute` | Execute via gateway (Model A or Model B) |
| `ALL` | `/v1/vault/llm/:provider/*` | Transparent LLM proxy (convenience route) |
| `POST` | `/v1/credentials/resolve` | Resolve a credential for external frameworks |

## Execute via Gateway

```
POST /v1/vault/execute
```

Unified execution gateway supporting both execution models.

### Model A: Token Vending

Returns a short-lived access token (max 1 hour) for the agent to use directly against the provider API. The refresh token is never exposed.

**Request**:

```json
{
  "model": "A",
  "connectionId": "uuid"
}
```

**Response**:

```json
{
  "model": "A",
  "accessToken": "ya29.a0AfH6SMB...",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "auditId": "uuid"
}
```

| Field | Type | Description |
|---|---|---|
| `accessToken` | `string` | Fresh access token (refreshed automatically if expired) |
| `tokenType` | `string` | Always `"Bearer"` |
| `expiresIn` | `number` | TTL in seconds (capped at 3600) |
| `auditId` | `string` | Audit event ID for this token vend |

### Model B: Brokered Proxy

Executes an HTTP request to the provider API on the agent's behalf. The agent never receives credentials. Requests are validated against policy allowlists (default-deny), checked for SSRF, and may require step-up approval for write actions.

**Request**:

```json
{
  "model": "B",
  "connectionId": "uuid",
  "method": "GET",
  "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  "query": { "maxResults": "10" },
  "headers": { "X-Custom": "value" },
  "body": null
}
```

| Field | Required | Description |
|---|---|---|
| `model` | Yes | `"B"` |
| `connectionId` | Conditional | Connection to use. Required for multi-account services (Google, Microsoft). Omit for singletons if `service` is provided. |
| `service` | Conditional | Service ID for singleton resolution (e.g., `"telegram"`, `"anthropic-messages"`). Use instead of `connectionId` for singleton services. |
| `method` | Yes | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` |
| `url` | Yes | Target URL (must match an allowlist entry) |
| `query` | No | Query parameters as key-value pairs |
| `headers` | No | Request headers (`Authorization`, `Cookie`, `Host` are stripped) |
| `body` | No | Request body (JSON or string) |
| `stream` | No | Stream the provider response directly instead of wrapping in a JSON envelope. Response rules (PII redaction, field filtering) are applied in real-time per event/chunk. |
| `download` | No | Return the raw binary response instead of wrapping in a JSON envelope. Use for file downloads (e.g., Google Drive `alt=media`). |
| `approvalId` | No | Approval request ID from a previous step-up approval (202 response). Pass this to redeem an approved request. |
| `requestFullFields` | No | Request full contact fields including PII (phone numbers, addresses, birthdays) for an **individual contact**. Only available on balanced-tier contacts policies and single-contact endpoints (not list/batch/search). Triggers step-up approval. See [Field Step-Up Approval](#field-step-up-approval). |

**Successful response (200)**:

```json
{
  "model": "B",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": { "messages": [...] },
  "auditId": "uuid"
}
```

**Step-up approval required (202)**:

When a write action triggers step-up approval, the request is stored and the response includes an approval request ID:

```json
{
  "approvalRequired": true,
  "approvalRequestId": "uuid",
  "expiresAt": "2025-06-01T00:05:00Z",
  "auditId": "uuid"
}
```

See the [Approvals](./approvals.md) page for how to approve or deny the request.

Once approved, the agent re-submits the same request with `approvalId`:

```json
{
  "model": "B",
  "connectionId": "uuid",
  "method": "POST",
  "url": "https://people.googleapis.com/v1/people:createContact",
  "body": { "names": [{ "givenName": "Jane" }] },
  "approvalId": "uuid-from-202-response"
}
```

### Field Step-Up Approval

For balanced (standard) tier contacts policies, PII fields (phone numbers, addresses, birthdays) are stripped from responses by default. The agent can request full fields for a **specific contact** via step-up approval:

1. Agent fetches the contact list (PII fields stripped)
2. Agent sends a single-contact request with `requestFullFields: true` -- receives 202 (approval required)
3. Workspace owner approves in dashboard (sees which contact is being accessed)
4. Agent re-submits with both `approvalId` and `requestFullFields: true` -- receives full contact data (notes still stripped)

```json
{
  "model": "B",
  "connectionId": "uuid",
  "method": "GET",
  "url": "https://people.googleapis.com/v1/people/c1234567890",
  "query": { "personFields": "names,emailAddresses,phoneNumbers,addresses" },
  "requestFullFields": true,
  "approvalId": "uuid-from-202-response"
}
```

**Restrictions:**
- Only works on **individual contact endpoints** (e.g., `GET /v1/people/{resourceName}` or `GET /v1.0/me/contacts/{id}`). List, search, and batch endpoints return 403 -- this prevents exposing PII for all contacts at once.
- Only works on balanced-tier contacts policies (`fieldStepUpEnabled: true`). Strict-tier policies return 403 -- PII fields are permanently stripped.
- Notes/biographies remain stripped even with approval.

### Error Responses

| Status | Description | Example |
|---|---|---|
| `400` | Invalid request (missing fields, bad method) | `{ "error": "Model B requires method and url" }` |
| `403` | Denied by allowlist, SSRF protection, or policy rule | `{ "error": "Request denied: ...", "auditId": "uuid" }` |
| `404` | Connection not found | `{ "error": "Connection not found" }` |
| `409` | Connection revoked or needs reauth | `{ "error": "Connection has been revoked" }` |
| `413` | Payload size exceeds limit | `{ "error": "Payload size exceeds limit of ... bytes", "auditId": "uuid" }` |
| `429` | Rate limit exceeded | `{ "error": "Rate limit exceeded: 100 requests per hour", "retryAfter": 1800, "auditId": "uuid" }` |
| `502` | Provider request failed | `{ "error": "Provider request failed", "auditId": "uuid" }` |

### Security Checks (Model B)

Model B requests pass through several security layers in order:

1. **Policy lookup** -- Finds a policy that allows Model B for this connection
2. **Time window check** -- Blocks requests outside allowed time windows
3. **Allowlist validation** -- Default-deny; request must match a configured allowlist entry
4. **SSRF protection** -- Blocks requests to private/reserved IP ranges
5. **Provider-specific enforcement** -- Telegram chat ID restrictions, Teams tenant/chat/channel restrictions
6. **Policy rules engine** -- Evaluates custom request rules (first match wins: allow/deny/require_approval)
7. **Step-up approval** -- May require human approval for write methods based on `stepUpApproval` setting
8. **Rate limit check** -- Enforced per agent+connection pair
9. **Payload size check** -- Request body size validated against policy limits

### Example: Model A Token Vending

```bash
curl -X POST http://localhost:8080/v1/vault/execute \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"model": "A", "connectionId": "conn-uuid"}'
```

### Example: Model B Brokered Proxy

```bash
curl -X POST http://localhost:8080/v1/vault/execute \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "B",
    "connectionId": "conn-uuid",
    "method": "GET",
    "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    "query": {"maxResults": "5"}
  }'
```

### Streaming (Model B)

When `stream: true` is set, the vault pipes the provider response directly to the client instead of wrapping it in a JSON envelope. This is useful for LLM chat completions (SSE), event feeds, and long-running operations.

**Request**:

```json
{
  "model": "B",
  "service": "anthropic-messages",
  "method": "POST",
  "url": "https://api.anthropic.com/v1/messages",
  "body": {
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{ "role": "user", "content": "Hello" }]
  },
  "stream": true
}
```

**Response**: The raw upstream response is streamed directly (e.g., SSE `text/event-stream` for LLM completions). No JSON envelope. Response rules (PII redaction, field filtering) are applied in real-time per event:

- **SSE** (`text/event-stream`): Each `data: {...}\n\n` event is parsed, filtered, and re-serialized
- **NDJSON** (`application/x-ndjson`): Each newline-delimited JSON line is parsed and filtered
- **Text**: PII redaction regex applied directly to each chunk
- **Binary/other**: Passed through unmodified

If no response rules are configured, chunks pass through with zero overhead.

:::info
Non-2xx responses fall through to the buffered path and return a proper error body, even when `stream: true`.
:::

## Transparent LLM Proxy

```
ALL /v1/vault/llm/:provider/*
```

Convenience route for AI SDKs. Translates SDK-style URLs into vault/execute parameters and runs through the full policy engine -- same code path, same security checks.

Supported providers: `anthropic`, `openai`, `gemini`, `openrouter`.

**How it works**: Configure your AI SDK's `baseURL` to point at the vault, and the SDK's native HTTP calls are proxied through the full policy pipeline:

```typescript
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: "https://vault.example.com/v1/vault/llm/anthropic",
  apiKey: "ah5_agent_api_key", // AgentHiFive agent API key
});

// This call goes through the vault -- policy rules, rate limits,
// PII redaction, and audit logging all apply transparently.
const message = await client.messages.create({
  model: "claude-sonnet-4-5-20250929",
  max_tokens: 1024,
  messages: [{ "role": "user", "content": "Hello" }],
});
```

The route automatically:

- Resolves the singleton connection for the provider
- Looks up the matching policy
- Detects streaming from the request body (`body.stream === true`)
- Runs all security checks (allowlists, rate limits, request rules, SSRF)
- Applies response rules in real-time for streaming responses

:::tip Backward compatibility
The previous path `/v1/llm/proxy/:provider/*` is still supported via a 308 redirect.
:::

## Resolve Credential

```
POST /v1/credentials/resolve
```

Resolves a credential from the vault. Designed for external agent frameworks (e.g., OpenClaw) that delegate credential storage to AgentHiFive.

**Request**:

```json
{
  "kind": "channel",
  "provider": "telegram",
  "profileId": "uuid-or-name",
  "fields": ["botToken"]
}
```

| Field | Required | Description |
|---|---|---|
| `kind` | Yes | Credential type: `model_provider`, `channel`, or `plugin_config` |
| `provider` | Yes | Provider identifier (e.g., `google`, `telegram`, `msteams`, `slack`) |
| `profileId` | No | Connection UUID for direct lookup, or a profile name for multi-account setups |
| `fields` | No | Hint about which credential fields are needed |

**Lookup strategy**:

- If `profileId` is a UUID: direct connection lookup by ID
- Otherwise: search by provider name, optionally filtered by service

**Response**:

```json
{
  "apiKey": "ya29.a0AfH6SMB...",
  "extra": { "tenantId": "tenant-uuid" },
  "source": "vault:google:conn-uuid",
  "mode": "oauth",
  "cacheTtlMs": 240000
}
```

| Field | Description |
|---|---|
| `apiKey` | Primary credential value (access token, bot token, or API key) |
| `extra` | Additional fields (e.g., `tenantId` for MS Teams, `appToken` for Slack) |
| `source` | Source identifier for audit/debugging |
| `mode` | Credential mode: `api-key`, `oauth`, `token`, or `aws-sdk` |
| `cacheTtlMs` | Suggested local cache TTL in milliseconds |

Returns `404` when no matching credential is found, signaling the caller to fall back to local credentials.
