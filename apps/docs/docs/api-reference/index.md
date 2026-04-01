---
title: API Reference
sidebar_position: 1
sidebar_label: Overview
description: Complete REST API reference for the AgentHiFive authority delegation platform.
---

# API Reference

The AgentHiFive API provides programmatic access to the authority delegation platform -- OAuth connection management, policy-based access control, an execution gateway, step-up approvals, and audit logging.

## Base URL

| Environment | Base URL |
|---|---|
| Local development | `http://localhost:8080/v1` |
| Production | Configured via `API_URL` environment variable |

All endpoints listed in this reference are relative to the `/v1` prefix unless otherwise noted.

## Authentication

Every request (except `/health` and agent auth endpoints) requires authentication via one of three methods:

| Method | Header | Description |
|---|---|---|
| **Bearer JWT** | `Authorization: Bearer <token>` | Short-lived JWT (5 min TTL) obtained via session cookie token exchange |
| **Personal Access Token** | `X-API-Key: ah5p_...` | Long-lived PAT generated from Settings. Prefixed with `ah5p_` |
| **Agent Access Token** | `Authorization: Bearer ah5t_...` | Short-lived opaque token (2 hour TTL) obtained via `private_key_jwt` assertion exchange |

See the [Authentication](./authentication.md) page for the full token exchange flow and JWT claims.

## Common Patterns

- **Workspace-scoped**: All resources are scoped to the authenticated user's workspace. You cannot access resources from other workspaces.
- **JSON request/response**: All request and response bodies use `application/json`.
- **Error shape**: All errors return a JSON object with an `error` string field:

```json
{ "error": "Description of what went wrong" }
```

- **UUIDs**: All resource IDs are UUIDv4 strings.
- **Audit IDs**: Mutating operations return an `auditId` field that can be used to correlate with audit log entries.

## Endpoint Groups

| Group | Prefix | Description |
|---|---|---|
| [Authentication](./authentication.md) | `/api/auth/*` | Token exchange, JWKS, PATs |
| [Connections](./connections.md) | `/v1/connections` | OAuth connection lifecycle -- initiation, callback, revocation, reauth |
| [Agents & Policies](./agents-policies.md) | `/v1/agents`, `/v1/policies` | Agent registration, policy bindings, allowlists, rate limits, time windows, rules |
| [Agent Authentication](./agent-auth.md) | `/v1/agents/enroll`, `/v1/agents/token` | Agent onboarding -- enrollment, key rotation, token exchange (unauthenticated) |
| [Execution](./execution.md) | `/v1/vault`, `/v1/credentials` | Execution gateway (Model A token vending, Model B brokered proxy), credential resolution |
| [Approvals](./approvals.md) | `/v1/approvals` | Step-up approval workflow for sensitive actions |
| [Audit](./audit.md) | `/v1/audit` | Audit event querying, filtering, and export |
| [Capabilities](./capabilities.md) | `/v1/capabilities` | Service catalog discovery, agent capability status |

Additional endpoint groups (not documented separately):

| Group | Prefix | Description |
|---|---|---|
| Workspaces | `/v1/workspaces` | Workspace/tenant management |
| Notification Channels | `/v1/notification-channels` | Configure Telegram, Slack, email notification delivery |
| Notifications | `/v1/notifications`, `/v1/notifications/stream` | In-app notification list + real-time SSE push |
| Agent Permission Requests | `/v1/agent-permission-requests` | Agent-initiated permission request workflow |
| Workspace OAuth Apps | `/v1/workspace-oauth-apps` | Bring-your-own OAuth app credentials (custom Google/Microsoft apps) |
| Dashboard | `/v1/dashboard` | Dashboard summary statistics |
| Tokens | `/v1/tokens` | Personal access token CRUD |
| Activity | `/v1/activity` | Human-readable activity feed (enriched audit events) |
| Admin | `/v1/admin` | Platform administration (superadmin only) |

## Interactive Docs

The API server exposes an interactive Swagger UI at `/docs` (e.g., `http://localhost:8080/docs` in development). The OpenAPI 3.1 spec is auto-generated from route schemas.

## Health Check

```
GET /health
```

Returns `{ "status": "ok" }`. Does not require authentication. Use this for liveness probes.
