---
title: Database
sidebar_position: 3
sidebar_label: Database
description: Drizzle ORM patterns, naming conventions, and migration workflow for AgentHiFive.
---

# Database

AgentHiFive uses **PostgreSQL 15+** as its sole data store and **Drizzle ORM** for type-safe database access. This page covers naming conventions, schema organization, and migration workflow.

## Naming Conventions

### Table Prefixes

Every table name uses a single-letter prefix to indicate its category:

| Prefix | Category | Purpose | Example |
|--------|----------|---------|---------|
| `t_` | **Transactional** | Core business entities (mutable) | `t_workspaces`, `t_connections` |
| `d_` | **Dictionary** | Static reference/lookup data | `d_provider_types` |
| `l_` | **Log** | Append-only audit and event records | `l_audit_events` |
| `r_` | **Relationship** | Junction tables for many-to-many | `r_policy_scopes` |

### Column Naming

All columns use `snake_case`:

| Pattern | Usage | Examples |
|---------|-------|---------|
| `id` | Primary key (UUID) | `id` |
| `{entity}_id` | Foreign key | `workspace_id`, `user_id` |
| `{verb}_at` | Timestamps | `created_at`, `updated_at`, `expires_at` |
| `{verb}_by` | Actor UUID | `created_by`, `revoked_by` |
| `is_{adjective}` | Boolean flags | `is_active`, `is_revoked` |

### Standard Audit Columns

All transactional tables include:

```sql
created_at  TIMESTAMPTZ  NOT NULL  DEFAULT now()
updated_at  TIMESTAMPTZ  NOT NULL  DEFAULT now()
```

Tables with soft-delete add `deleted_at` and `deleted_by`.

### Index and Constraint Naming

| Type | Pattern | Example |
|------|---------|---------|
| Index | `idx_{table}_{columns}` | `idx_connections_workspace_id` |
| Primary key | `{table}_pkey` | `t_users_pkey` |
| Unique | `{table}_{columns}_unique` | `t_users_email_unique` |
| Foreign key | `{table}_{column}_fkey` | `t_connections_workspace_id_fkey` |
| Check | `{table}_{column}_check` | `t_policies_rate_limit_check` |

## Current Tables

### Transactional Tables (`t_`)

| Table | Drizzle Variable | Description |
|-------|-----------------|-------------|
| `t_users` | `users` | User accounts (auth + profile) |
| `t_sessions` | `sessions` | Auth sessions |
| `t_accounts` | `accounts` | OAuth provider accounts |
| `t_verifications` | `verifications` | Email verification tokens |
| `t_workspaces` | `workspaces` | Tenant organizations |
| `t_connections` | `connections` | OAuth provider connections |
| `t_pending_connections` | `pendingConnections` | In-progress OAuth flows |
| `t_agents` | `agents` | Registered AI agents/apps |
| `t_policies` | `policies` | Access policies |
| `t_approval_requests` | `approvalRequests` | Step-up approval workflow |
| `t_personal_access_tokens` | `personalAccessTokens` | API tokens for agents |

### Log Tables (`l_`)

| Table | Drizzle Variable | Description |
|-------|-----------------|-------------|
| `l_audit_events` | `auditEvents` | Append-only audit trail |

## Drizzle Schema Conventions

### Table Definitions

```typescript
// File: apps/api/src/db/schema/users.ts
import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const users = pgTable("t_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

### Variable Naming

| Convention | Pattern | Example |
|------------|---------|---------|
| Table variable | `camelCase` plural noun | `users`, `auditEvents` |
| Column property | `camelCase` | `workspaceId`, `createdAt` |
| Column DB name | `snake_case` (in string) | `"workspace_id"`, `"created_at"` |

### Schema File Organization

```
apps/api/src/db/schema/
  index.ts              # Re-exports all tables
  users.ts              # t_users, t_sessions, t_accounts, t_verifications
  workspaces.ts         # t_workspaces
  connections.ts        # t_connections
  pending-connections.ts # t_pending_connections
  agents.ts             # t_agents
  policies.ts           # t_policies
  approval-requests.ts  # t_approval_requests
  personal-access-tokens.ts # t_personal_access_tokens
  audit-events.ts       # l_audit_events
  enums.ts              # PostgreSQL enum types
```

## Migration Workflow

AgentHiFive uses Drizzle Kit for schema migrations.

### Development

```bash
# Push schema changes directly to the dev database (no migration files)
make migrate

# This runs: pnpm --filter @agenthifive/api run migrate
```

### Adding a New Table

1. Determine the category prefix (`t_`, `d_`, `l_`, or `r_`).
2. Name the table as `{prefix}_{plural_snake_case_noun}`.
3. Include standard audit columns (`created_at`, `updated_at`).
4. Create or update the Drizzle schema file under `apps/api/src/db/schema/`.
5. Export the table from `schema/index.ts`.
6. Run `make migrate` to push changes to the database.

:::info Auth Tables
Authentication tables (`t_users`, `t_sessions`, `t_accounts`, `t_verifications`) are defined in the Drizzle schema and follow the same conventions. Better Auth uses our schema via the Drizzle adapter -- we own the tables, not the framework.
:::
