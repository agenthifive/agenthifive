---
title: Audit
sidebar_position: 7
sidebar_label: Audit
description: Audit log endpoints for querying and exporting execution events, policy changes, and approval actions.
---

# Audit

Every significant action in AgentHiFive is recorded as an audit event -- token vends, execution requests, policy changes, approval decisions, rate limit violations, and more. The audit API provides querying and export capabilities for compliance and debugging.

## Endpoint Summary

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/audit` | List audit events (paginated) |
| `GET` | `/v1/audit/export` | Export audit events as JSON or CSV |

## Audit Event Shape

Each audit event contains:

```json
{
  "id": "uuid",
  "auditId": "uuid",
  "timestamp": "2025-06-01T12:00:00Z",
  "actor": "user-id",
  "agentId": "uuid-or-null",
  "connectionId": "uuid-or-null",
  "action": "execution_completed",
  "decision": "allowed",
  "metadata": {
    "model": "B",
    "method": "GET",
    "path": "/gmail/v1/users/me/messages",
    "responseStatus": 200,
    "dataSize": 4096,
    "provider": "google"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Internal row ID |
| `auditId` | `string` | Public audit event ID (used as cursor for pagination) |
| `timestamp` | `string` | ISO 8601 timestamp |
| `actor` | `string` | User ID who triggered the action |
| `agentId` | `string?` | Agent involved (if applicable) |
| `connectionId` | `string?` | Connection involved (if applicable) |
| `action` | `string` | Event type (see action types below) |
| `decision` | `string` | Outcome: `allowed`, `denied`, etc. |
| `metadata` | `object` | Action-specific details |

### Action Types

| Action | Description |
|---|---|
| `token_vended` | Model A: access token successfully returned |
| `token_vend_denied` | Model A: token vend blocked (policy, time window, rate limit) |
| `execution_requested` | Model B: proxy request initiated |
| `execution_completed` | Model B: proxy request completed successfully |
| `execution_denied` | Model B: request blocked (allowlist, SSRF, policy rule, chat restriction) |
| `execution_error` | Model B: provider request failed |
| `rate_limit_exceeded` | Request blocked by rate limiting |
| `approval_requested` | Step-up approval created |
| `approval_approved` | Step-up approval granted |
| `approval_denied` | Step-up approval rejected |
| `approval_expired` | Step-up approval expired (5 min timeout) |
| `connection_revoked` | Connection revoked by user |
| `connection_needs_reauth` | Connection marked as needing reauthentication |
| `credential_resolved` | Credential resolved via `/credentials/resolve` |
| `policy_created` | New policy created |
| `policy_updated` | Policy settings, allowlists, rate limits, time windows, or rules updated |
| `policy_deleted` | Policy removed |
| `agent_updated` | Agent name/description/icon changed |
| `agent_deleted` | Agent permanently deleted |

## List Audit Events

```
GET /v1/audit
```

Returns paginated audit events for the current workspace, ordered by timestamp (newest first). Uses cursor-based pagination.

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `agentId` | `uuid` | Filter by agent |
| `connectionId` | `uuid` | Filter by connection |
| `action` | `string` | Filter by action type (e.g., `token_vended`, `execution_completed`) |
| `dateFrom` | `datetime` | Start of date range (ISO 8601) |
| `dateTo` | `datetime` | End of date range (ISO 8601) |
| `cursor` | `string` | Cursor (`auditId`) from previous page's `nextCursor` |
| `limit` | `number` | Page size (default: 50, max: 200) |

### Response

```json
{
  "events": [ ... ],
  "nextCursor": "audit-id-or-null"
}
```

Pass `nextCursor` as the `cursor` query parameter to fetch the next page. When `nextCursor` is `null`, there are no more results.

### Example: Paginated Query

```bash
# First page
curl -H "Authorization: Bearer $JWT" \
  "http://localhost:8080/v1/audit?limit=20&action=execution_completed"

# Next page (use nextCursor from previous response)
curl -H "Authorization: Bearer $JWT" \
  "http://localhost:8080/v1/audit?limit=20&action=execution_completed&cursor=prev-audit-id"
```

### Example: Filter by Date Range

```bash
curl -H "Authorization: Bearer $JWT" \
  "http://localhost:8080/v1/audit?dateFrom=2025-06-01T00:00:00Z&dateTo=2025-06-30T23:59:59Z"
```

## Export Audit Events

```
GET /v1/audit/export
```

Exports all matching audit events as a downloadable file. Supports the same filters as the list endpoint but returns the full dataset without pagination.

### Query Parameters

| Parameter | Type | Description |
|---|---|---|
| `format` | `string` | Export format: `json` (default) or `csv` |
| `agentId` | `uuid` | Filter by agent |
| `connectionId` | `uuid` | Filter by connection |
| `action` | `string` | Filter by action type |
| `dateFrom` | `datetime` | Start of date range |
| `dateTo` | `datetime` | End of date range |

### Example: JSON Export

```bash
curl -H "Authorization: Bearer $JWT" \
  "http://localhost:8080/v1/audit/export?format=json&dateFrom=2025-06-01T00:00:00Z" \
  -o audit-export.json
```

### Example: CSV Export

```bash
curl -H "Authorization: Bearer $JWT" \
  "http://localhost:8080/v1/audit/export?format=csv" \
  -o audit-export.csv
```

**CSV columns**: `audit_id`, `timestamp`, `actor`, `agent_id`, `connection_id`, `action`, `decision`, `metadata`

## Workspace Scoping

Audit events are scoped to the current workspace. An event is visible if any of the following are true:

- The `actor` matches the authenticated user
- The `agentId` belongs to a workspace agent
- The `connectionId` belongs to a workspace connection

This ensures workspace isolation while still showing all relevant activity.
