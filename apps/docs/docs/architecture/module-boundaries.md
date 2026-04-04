---
title: Module Boundaries
sidebar_position: 2
sidebar_label: Module Boundaries
description: Ownership rules for each app and package in the AgentHiFive monorepo.
---

# Module Boundaries

Each module in the monorepo has strict ownership rules. No module writes another module's database tables directly, and cross-module communication happens through well-defined interfaces.

## Apps

### apps/web (Next.js)

| Aspect | Details |
|--------|---------|
| **Owns** | Better Auth config and routes (`/api/auth/*`), user sessions (HttpOnly cookie), passkey enrollment/login, social sign-in UX |
| **Exposes** | Dashboard UI, auth flows |
| **Must NOT** | Store provider refresh tokens, poll device flow, call provider token endpoints directly, serve JWKS or issue JWTs (those live in the Fastify API) |

### apps/api (Fastify)

| Aspect | Details |
|--------|---------|
| **Owns** | Business APIs, JWT validation plugin (via JWKS), OAuth integration service (auth code flow), encrypted token vault, RBAC/scope authorization, policy engine |
| **Exposes** | `/v1/*` business APIs, `/v1/oauth/{provider}/start` (web auth-code connect), `/v1/oauth/{provider}/callback` (OAuth callback), `GET /.well-known/jwks.json` (public key for JWT verification), `POST /api/internal/token/exchange` (session to JWT exchange) |
| **Must NOT** | Handle passkey ceremonies for app login, manage browser user sessions |

## Packages

| Package | Owns | Exports | Must NOT |
|---------|------|---------|----------|
| **packages/contracts** | Zod schemas and TS types for all cross-service requests/responses, JWT claim interfaces (`ApiAccessClaims`, `WorkspaceRole`, `Scope`) | Types, schemas, branded ID types | Include runtime HTTP logic |
| **packages/security** | AES-256-GCM encryption utilities, envelope encryption, key rotation helpers (`kid`, key versioning) | `EnvelopeEncryptor`, `EncryptedEnvelopeV1` | Know database schema details |
| **packages/sdk** | Official TypeScript SDK for external consumers | SDK client, typed request/response helpers | Depend on internal app code |
| **packages/oauth-connectors** | Provider metadata discovery, oauth4webapi wrappers for auth-code exchange, refresh, revoke | `OAuthConnector` interface, `ProviderCapabilities`, per-provider implementations | Access web session state |
| **packages/openclaw** | OpenClaw Gateway plugin for routing and lifecycle management | Gateway plugin interface | Access database directly |
| **packages/agenthifive-mcp** | MCP server implementation (stdio transport) | MCP server entry point | Depend on internal app code |
| **packages/openclaw-setup** | OpenClaw setup and configuration utilities | Setup helpers, config generators | Access web session state |
| **packages/integration-sdk** | Integration SDK for third-party integrations | Integration interfaces, helpers | Depend on internal app code |

## Data Ownership

| Data | Owner | Notes |
|------|-------|-------|
| `t_users`, `t_sessions`, `t_accounts` | apps/api | Better Auth tables (managed by Fastify API) |
| `t_connections`, `t_pending_connections` | apps/api | Provider integrations |
| `t_agents`, `t_agent_bootstrap_secrets` | apps/api | Agent registration and auth |
| `l_audit_events` | apps/api | Audit trail (append-only log table) |
| `t_policies` | apps/api | Policy engine configuration |
| `t_approval_requests` | apps/api | Human-in-the-loop approvals |
| `t_workspaces` | apps/api | Workspace multi-tenancy |

## Token Model

The system uses three distinct token types, each scoped to its layer:

### 1. Web Session Cookie (Better Auth)

- **Scope:** Browser only
- **Security:** HttpOnly, SameSite=Lax/Strict
- **Lifetime:** 30 days (configurable)
- **Contains:** Session ID referencing the database

### 2. Internal API JWT (issued by apps/web)

- **Scope:** Web UI to API calls
- **TTL:** 5 minutes
- **Audience:** `api`
- **Issuer:** `web`
- **Claims:** `{ sub, wid, roles, scp, sid }`
- **Verification:** JWKS from `/.well-known/jwks.json`

### 3. Provider Token Set (stored by apps/api)

- **Contents:** `access_token`, `refresh_token`, `expiry`, `provider_account_id`
- **Storage:** Encrypted at rest (AES-256-GCM) with key ID for rotation
- **Rotation:** Key versioning supported via `kid`

## Dependency Flow

```
apps/web ──────────────> packages/contracts
    |
    +──────────────> packages/sdk

apps/api ──────────────> packages/contracts
    |
    +──────────────> packages/security
    |
    +──────────────> packages/oauth-connectors ──> packages/contracts

apps/cli ──────────────> packages/contracts
    |
    +──────────────> packages/sdk

packages/openclaw ─────> packages/contracts
packages/agenthifive-mcp > packages/contracts
packages/openclaw-setup -> packages/contracts
packages/integration-sdk > packages/contracts
```

Packages depend only on other packages, never on apps. Apps depend on packages and never on each other -- they communicate over HTTP.
