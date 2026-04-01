# AgentHiFive

Authority delegation platform for AI agents. Lets workspace owners connect OAuth provider accounts (Google, Microsoft, Telegram) and grant AI agents scoped, audited, policy-governed access to those accounts through a Vault API.

## Quick Reference

```
make prereqs          # Install nvm, Node 24, pnpm, Docker (fresh machine)
make init             # Install deps, build packages, start DB, run migrations
make dev              # Start web (:3000) + api (:4000) — builds packages first
make test             # Run full test suite (needs test DB on :5433)
make lint && make typecheck   # Quality checks
```

## Monorepo Structure

```
apps/
  web/              Next.js 16 static SPA (dashboard UI, auth client)
  api/              Fastify 5.x backend (Better Auth, JWKS, Vault API, policy engine, audit)
  cli/              CLI tool
  docs/             Docusaurus 3.x documentation site (:3001)
packages/
  contracts/        Shared Zod 4.x schemas and TypeScript types
  security/         AES-256-GCM encryption utilities
  sdk/              Official TypeScript SDK
  oauth-connectors/ OAuth provider adapters (Google, Microsoft)
  openclaw/         OpenClaw Gateway plugin
  agenthifive-mcp/  MCP server (stdio transport)
integration-testing/  Fully containerized e2e tests (Docker Compose)
```

Managed with **pnpm 9.x workspaces** and **Turborepo 2.x**. The `dev` task depends on `^build` — Turbo builds shared packages before starting app dev servers.

## Tech Stack

- **Runtime:** Node.js 24
- **Frontend:** Next.js 16, React 19, Tailwind 4.x
- **Backend:** Fastify 5.x with typed routes
- **Auth:** Better Auth (server in Fastify API, Drizzle adapter; client hooks in web app)
- **JWT:** jose with JWKS served from Fastify at `/.well-known/jwks.json`
- **Database:** PostgreSQL 15+ only (no Redis). Drizzle ORM, no raw SQL.
- **Validation:** Zod 4.x (schemas in `packages/contracts`)
- **OAuth:** oauth4webapi (not Arctic — Arctic lacks device flow)
- **Encryption:** AES-256-GCM via `packages/security`
- **TypeScript:** 5.7+ strict mode everywhere

## Architecture

### Request Flow

```
Browser → /               → static SPA (built Next.js export)
        → /api/auth/*     → Fastify (Better Auth)
        → /v1/*           → Fastify (API)
        → /.well-known/*  → Fastify (JWKS)
```

### JWT Auth

Better Auth creates sessions on Fastify. Fastify signs JWTs and serves a JWKS endpoint at `/.well-known/jwks.json`. The API validates JWTs using `jose` + `createRemoteJWKSet` from `WEB_JWKS_URL`.

JWT claims: `sub` (user ID), `wid` (workspace ID), `roles` (array), `scp` (scopes array), `sid` (session ID).

### Execution Models

- **Model A (Token Vending):** Agent gets a short-lived access token to call the provider directly.
- **Model B (Brokered Proxy):** Agent sends the request through AgentHiFive; the Vault makes the provider call on the agent's behalf.

Both go through `POST /v1/vault/execute` with a `"model": "A"` or `"B"` discriminator.

### Policy Engine

Policies bind an agent to a connection with rules:
- `allowedModels`: `["A"]`, `["B"]`, or `["A", "B"]`
- `defaultMode`: `"read_only"`, `"read_write"`, or `"custom"`
- `stepUpApproval`: `"always"`, `"risk_based"`, or `"never"`
- Allowlists (base URL + path patterns + HTTP methods)
- Rate limits (`maxRequestsPerHour`, optional payload/response size limits)
- Time windows (day-of-week + hour range + timezone)
- Request rules (first-match: allow/deny/require_approval)
- Response rules (field filtering + PII redaction)

## Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Files and directories | `kebab-case` | `jwt-auth.ts`, `oauth-connectors/` |
| TypeScript variables | `camelCase` | `workspaceId`, `auditEvents` |
| TypeScript types | `PascalCase` | `ExecuteRequest`, `PolicySummary` |
| Database tables | `snake_case` with prefix | `t_connections`, `l_audit_events` |
| Database columns | `snake_case` | `workspace_id`, `created_at` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `WEB_JWKS_URL` |

### Database Table Prefixes

| Prefix | Category | Example |
|--------|----------|---------|
| `t_` | Transactional (mutable business entities) | `t_workspaces`, `t_connections` |
| `d_` | Dictionary (static reference data) | `d_provider_types` |
| `l_` | Log (append-only audit records) | `l_audit_events` |
| `r_` | Relationship (junction tables) | `r_policy_scopes` |

All transactional tables include `created_at` and `updated_at` (timestamptz, defaultNow). Schema files live in `apps/api/src/db/schema/` and are re-exported from `schema/index.ts`.

## Testing

**212+ tests** across 15 files using `node:test` + `node:assert/strict`. Real PostgreSQL on port 5433 (Docker), mocked externals.

```bash
# Full suite (starts test DB, migrates, runs all tests)
cd apps/api && bash run-tests.sh

# Single file
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 \
  --test-force-exit 'src/__tests__/routes/policies.test.ts'
```

### Test Patterns

- **Real DB, mocked externals.** PostgreSQL in Docker; OAuth providers and `undici` are mocked via `mock.module()`.
- **Dynamic imports.** Routes must be `await import()`'d **after** setting env vars.
- **`--experimental-test-module-mocks`** flag is required for `mock.module()`.
- **Sequential:** `--test-concurrency=1` prevents cross-file DB interference.
- **UUID validity:** Test UUIDs must use valid hex chars (0-9, a-f).
- **Fire-and-forget:** Audit logging and token re-encryption are async. Use `await delay(50-100)` before asserting DB state.
- **Fastify `inject()`** for HTTP testing — no real server started.

## Database Migrations

```bash
make migrate              # Push schema to dev DB (drizzle-kit push)
make migrate-generate     # Generate migration files
make db-reset             # Drop + recreate DB + migrate
```

## Development Philosophy

- **No backwards compatibility yet.** Change any API, schema, or interface freely.
- **Always aim for the best design.** Don't compromise to preserve old behavior.
- **Delete dead code.** No deprecation shims, no unused re-exports.

## Workflow: Changing an API Endpoint

When modifying any API route in `apps/api/src/routes/`, always update **all four layers**:

1. **Route handler** — implement the change in the route file
2. **Swagger/OpenAPI schema** — update the `schema` object on the route
3. **Tests** — update or add tests in `apps/api/src/__tests__/routes/`
4. **Documentation** — update the corresponding page in `apps/docs/docs/`

## Important Patterns

- **No raw SQL in app code.** Use Drizzle ORM operators.
- **Zod schemas in `packages/contracts`**, not in route files.
- **Async audit logging.** Never block the response path.
- **SSRF protection.** All Model B outbound URLs go through `checkHostSafety()`.
- **Vault error hints.** Every vault denial must include a `hint` field.
- **Workspace scoping.** Every query must filter by `wid` from the JWT.
- **Package builds required.** Run `pnpm turbo build --filter='./packages/*'` if you get `ERR_MODULE_NOT_FOUND`.
- **Extension point:** `buildApp()` and `startServer()` in `apps/api/src/server.ts` are exported for external composition. Do not break these exports.
