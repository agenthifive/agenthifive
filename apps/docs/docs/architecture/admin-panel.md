---
sidebar_position: 8
title: Admin Panel
description: Enterprise administration dashboard and API for platform management
---

# Admin Panel

## Overview

The admin panel is an enterprise-only superadmin dashboard for platform-wide management of users, workspaces, and audit logs. It consists of two components:

- **`@agenthifive/admin`** -- A Next.js 16 application (runs on port 3002) that provides the web UI. Built with React 19, TailwindCSS 4, and TanStack React Query.
- **Enterprise API routes** -- A set of Fastify routes registered under `/v1/admin/*` that the admin app consumes.

The enterprise API (`apps/enterprise-api`) extends the core AgentHiFive API by importing `buildApp()` and `startServer()` from the core, then registering additional route plugins for admin management and push notification subscriptions.

### Admin UI Pages

The admin app uses Next.js App Router with two route groups:

| Route | Description |
|---|---|
| `/login` | Superadmin authentication form |
| `/` (dashboard) | Platform overview / stats |
| `/users` | Paginated user list with search |
| `/users/[id]` | User detail with workspace, agents, and connections |
| `/workspaces` | Paginated workspace list |
| `/workspaces/[id]` | Workspace detail with agent and connection lists |
| `/audit` | Platform-wide audit event log |

## Access Control

### Superadmin Role Requirement

Every admin API endpoint requires the `superadmin` platform role. The `requireSuperadmin` preHandler hook is attached to all routes in the admin plugin. It checks `request.user.platformRole` and returns a `403` response with `{ error: "Superadmin access required" }` if the caller is not a superadmin.

```typescript
// plugins/admin-guard.ts
export async function requireSuperadmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (request.user.platformRole !== "superadmin") {
    return reply.code(403).send({ error: "Superadmin access required" });
  }
}
```

The guard is registered as a `preHandler` hook on the entire admin routes plugin, so it applies to every route under `/v1/admin/*` automatically.

### Superadmin Bootstrap (Seeding)

The first superadmin account is created automatically on server startup via the `seedSuperadmin()` service. This function is idempotent and runs every time the enterprise API starts.

**Behavior:**

1. Reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` from environment variables.
2. If either variable is missing, the seed is skipped silently (safe for CI environments).
3. If a user with that email already exists and is already a superadmin, no action is taken.
4. If a user with that email exists but is not a superadmin, the user is promoted to superadmin and email verification is set to `true`.
5. If no user exists, a new account is created via Better Auth's `signUpEmail` API (which handles password hashing), then promoted to superadmin with email verification bypassed.
6. Includes race-condition recovery -- if account creation fails due to a concurrent insert, it finds and promotes the existing row.

## Admin API Endpoints

All endpoints below are prefixed with `/v1` and require superadmin authentication. Responses use JSON. Admin actions that modify users are recorded in the audit log.

### GET /v1/admin/stats

**Platform statistics.** Returns platform-wide summary counts.

- **Auth:** Superadmin required
- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `totalUsers` | integer | Total registered users |
| `totalWorkspaces` | integer | Total workspaces |
| `totalAgents` | integer | Total agents across all workspaces |
| `totalConnections` | integer | Total connections across all workspaces |
| `recentAuditCount` | integer | Audit events in the last 7 days |

---

### GET /v1/admin/users

**List all users.** Paginated user list with optional search by email or name.

- **Auth:** Superadmin required
- **Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `search` | string | -- | Filter users by email or name (case-insensitive ILIKE) |
| `limit` | string | `"50"` | Page size (max 100) |
| `offset` | string | `"0"` | Pagination offset |

- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `users` | array | List of user summary objects |
| `total` | integer | Total matching user count |

Each user object contains: `id`, `email`, `name`, `platformRole`, `emailVerified`, `disabledAt` (nullable), `createdAt`, `workspaceName` (nullable).

---

### GET /v1/admin/users/:id

**User detail.** Returns a single user with workspace info, agent count, connection count, and a list of connections.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- User ID
- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `id` | string | User ID |
| `email` | string | User email |
| `name` | string | User display name |
| `platformRole` | string | `"user"` or `"superadmin"` |
| `emailVerified` | boolean | Whether email is verified |
| `disabledAt` | string or null | Timestamp if disabled |
| `createdAt` | string | Account creation timestamp |
| `workspaceId` | string or null | Owned workspace ID |
| `workspaceName` | string or null | Owned workspace name |
| `agentCount` | integer | Number of agents in workspace |
| `connectionCount` | integer | Number of connections in workspace |
| `connections` | array | List of connection objects (`id`, `provider`, `service`, `label`, `status`, `createdAt`) |

- **Response (404):** `{ "error": "User not found" }`

---

### PATCH /v1/admin/users/:id/role

**Change user platform role.** Promote a user to superadmin or demote to regular user. Cannot change your own role.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- Target user ID
- **Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `platformRole` | string | Yes | `"user"` or `"superadmin"` |

- **Response (200):** `{ "ok": true }`
- **Response (400):** `{ "error": "Cannot change own role" }`
- **Response (404):** `{ "error": "User not found" }`
- **Audit event:** `admin:user.role_changed` with `{ targetId, platformRole }`

---

### POST /v1/admin/users/:id/disable

**Disable user.** Sets `disabled_at` timestamp and deletes all of the user's sessions for immediate lockout. Cannot disable your own account.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- Target user ID
- **Response (200):** `{ "ok": true }`
- **Response (400):** `{ "error": "Cannot disable own account" }`
- **Response (404):** `{ "error": "User not found or already disabled" }`
- **Audit event:** `admin:user.disabled` with `{ targetId }`

---

### POST /v1/admin/users/:id/enable

**Re-enable user.** Clears the `disabled_at` timestamp so a previously disabled user can log in again.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- Target user ID
- **Response (200):** `{ "ok": true }`
- **Response (404):** `{ "error": "User not found or not disabled" }`
- **Audit event:** `admin:user.enabled` with `{ targetId }`

---

### DELETE /v1/admin/users/:id

**Delete user.** Hard-deletes a user and cascades to their workspace, agents, connections, and policies via foreign key constraints. Cannot delete your own account.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- Target user ID
- **Response (200):** `{ "ok": true }`
- **Response (400):** `{ "error": "Cannot delete own account" }`
- **Response (404):** `{ "error": "User not found" }`
- **Audit event:** `admin:user.deleted` with `{ targetId }`

---

### GET /v1/admin/workspaces

**List all workspaces.** Returns all workspaces with owner info and resource counts.

- **Auth:** Superadmin required
- **Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | string | `"50"` | Page size (max 100) |
| `offset` | string | `"0"` | Pagination offset |

- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `workspaces` | array | List of workspace objects |
| `total` | integer | Total workspace count |

Each workspace object contains: `id`, `name`, `ownerEmail`, `ownerName`, `agentCount`, `connectionCount`, `createdAt`.

---

### GET /v1/admin/workspaces/:id

**Workspace detail.** Returns workspace info with full lists of agents and connections. Never exposes decrypted tokens.

- **Auth:** Superadmin required
- **Path parameters:** `id` (string) -- Workspace ID
- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `id` | string | Workspace ID |
| `name` | string | Workspace name |
| `ownerEmail` | string | Owner's email |
| `ownerName` | string | Owner's display name |
| `createdAt` | string | Creation timestamp |
| `agents` | array | List of agent objects (`id`, `name`, `status`, `createdAt`) |
| `connections` | array | List of connection objects (`id`, `provider`, `service`, `label`, `status`, `createdAt`) |

- **Response (404):** `{ "error": "Workspace not found" }`

---

### GET /v1/admin/audit

**Cross-workspace audit log.** Returns paginated audit events across all workspaces with cursor-based pagination.

- **Auth:** Superadmin required
- **Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `action` | string | -- | Filter by action name (exact match) |
| `cursor` | string | -- | Cursor for pagination (an `auditId` from a previous response) |
| `limit` | string | `"50"` | Page size (max 100) |

- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `events` | array | List of audit event objects |
| `nextCursor` | string or null | Cursor for the next page, or `null` if no more results |

Each event object contains: `auditId`, `action`, `actor`, `agentId` (nullable), `connectionId` (nullable), `metadata` (nullable), `timestamp`.

## Push Subscription Endpoints

These endpoints manage Expo push notification tokens for the mobile app. They are registered under `/v1/push/*` and require standard authentication (any logged-in user, not superadmin-specific).

### POST /v1/push/subscribe

**Register push token.** Registers or updates an Expo push token for the authenticated user and device. Upserts on the token -- if the same device switches accounts, the existing row is updated.

- **Auth:** Authenticated user required
- **Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `expoPushToken` | string | Yes | Expo push token (must start with `ExponentPushToken[`) |
| `platform` | string | Yes | `"ios"` or `"android"` |
| `deviceName` | string | No | Optional human-readable device name |

- **Response (200):**

| Field | Type | Description |
|---|---|---|
| `id` | string (uuid) | Subscription record ID |
| `expoPushToken` | string | The registered token |
| `platform` | string | `"ios"` or `"android"` |
| `deviceName` | string or null | Device name if provided |

- **Response (400):** `{ "error": "Invalid Expo push token format" }`

---

### DELETE /v1/push/unsubscribe

**Remove push token.** Removes an Expo push token so the device no longer receives push notifications. Only deletes tokens belonging to the authenticated user.

- **Auth:** Authenticated user required
- **Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `expoPushToken` | string | Yes | The Expo push token to remove |

- **Response (200):** `{ "deleted": true }` or `{ "deleted": false }` if the token was not found for this user.

## Enterprise API Architecture

The enterprise API (`apps/enterprise-api`) wraps the core AgentHiFive API rather than forking it. The startup sequence in `server.ts` is:

1. **Import core API** -- `buildApp()` and `startServer()` are imported from `core/apps/api/src/server.ts`.
2. **Build the core app** -- `buildApp()` returns a fully configured Fastify instance with all core routes, plugins, database connections, and authentication.
3. **Seed superadmin** -- `seedSuperadmin(app.log)` runs idempotently to ensure the bootstrap admin account exists.
4. **Register enterprise routes** -- Additional route plugins are registered under the `/v1` prefix:
   - `pushSubscriptionRoutes` -- Push notification token management
   - `adminRoutes` -- Superadmin management endpoints
5. **Start server** -- `startServer(app)` binds the Fastify instance to the configured port.

This architecture means the enterprise API includes all core API routes plus the enterprise-specific additions, served from a single process.

## Configuration

The following environment variables are used by the admin panel system:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_EMAIL` | No | Email address for the bootstrap superadmin account. If not set, no superadmin is seeded on startup. |
| `ADMIN_PASSWORD` | No | Password for the bootstrap superadmin account. Must be set together with `ADMIN_EMAIL`. |

Both variables are optional in the sense that the server will start without them, but at least one superadmin account is needed to access the admin panel. In production, set both variables on first deployment to bootstrap the initial superadmin, then optionally remove them once additional superadmins have been promoted via the API.
