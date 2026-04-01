---
title: Error Handling
sidebar_position: 3
sidebar_label: Error Handling
description: Handle API errors, inspect error codes, and implement retry logic with the AgentHiFive SDK.
---

# Error Handling

The SDK throws `AgentHiFiveError` when the API returns a non-2xx status code. This class extends the standard `Error` with additional properties for structured error handling.

## AgentHiFiveError

```typescript
import { AgentHiFiveError } from "@agenthifive/sdk";
```

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `message` | `string` | Human-readable error message from the API. |
| `statusCode` | `number` | HTTP status code (e.g., 400, 401, 403, 404, 429, 500). |
| `auditId` | `string \| undefined` | Audit trail ID for the failed request, when available. Useful for support inquiries. |
| `retryAfter` | `number \| undefined` | Seconds until retry is allowed. Present on `429 Too Many Requests` responses. |

## Basic Usage

```typescript
try {
  await client.execute({
    model: "B",
    connectionId: "id",
    method: "GET",
    url: "https://api.example.com/resource",
  });
} catch (err) {
  if (err instanceof AgentHiFiveError) {
    console.error(`Error ${err.statusCode}: ${err.message}`);
    if (err.auditId) console.error("Audit ID:", err.auditId);
  }
}
```

## Common Error Codes

| Status | Meaning | Typical Cause |
|--------|---------|---------------|
| `400` | Bad Request | Invalid request parameters or missing required fields. |
| `401` | Unauthorized | Missing or invalid API key. |
| `403` | Forbidden | Insufficient permissions or policy violation. |
| `404` | Not Found | Connection, agent, or policy does not exist. |
| `429` | Too Many Requests | Rate limit exceeded. Check `retryAfter`. |
| `500` | Internal Server Error | Unexpected server-side failure. |

## Retry Pattern for Rate Limits

When the API returns `429`, the `retryAfter` property indicates how many seconds to wait before retrying.

```typescript
async function executeWithRetry(client: AgentHiFiveClient, options: any, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.execute(options);
    } catch (err) {
      if (err instanceof AgentHiFiveError && err.statusCode === 429 && err.retryAfter) {
        await new Promise((resolve) => setTimeout(resolve, err.retryAfter! * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded");
}
```

:::tip Audit IDs
When reporting issues, always include the `auditId` from the error. This allows the AgentHiFive team to trace the exact request in the audit log.
:::
