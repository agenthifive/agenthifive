---
title: Testing
sidebar_position: 2
sidebar_label: Testing
description: Test architecture, patterns, coverage, and how to run the AgentHiFive test suite.
---

# Testing

The AgentHiFive API test suite uses **real PostgreSQL database integration tests** running against an isolated Docker container. This approach validates the full request lifecycle -- from HTTP injection through JWT authentication, route handling, Drizzle ORM queries, and JSON response serialization -- without mocking the database layer.

## Key Metrics

- **212+ tests** across 15 test files
- **15 test files** covering all routes, plugins, services, and utilities
- **0 external service calls** -- OAuth providers and HTTP clients are mocked at the module level

## Technology Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Test runner | `node:test` (built-in) | Zero external dependencies |
| Assertions | `node:assert/strict` | Standard library |
| TypeScript | `tsx` loader | Via `--import tsx` |
| Module mocking | `mock.module()` | `--experimental-test-module-mocks` flag |
| Database | PostgreSQL 15 (Docker) | Port 5433, isolated from dev DB |
| HTTP testing | Fastify `inject()` | In-process, no network I/O |
| JWT | Real RS256 key pairs | Mock JWKS HTTP server |

## Design Principles

1. **Real database, mocked externals.** PostgreSQL runs in Docker; OAuth providers, HTTP clients (`undici`), and encryption are mocked where needed.
2. **Isolation.** Each test file gets its own workspace, agent, and connection data. `beforeEach()` cleans test-specific tables between tests.
3. **Sequential execution.** `--test-concurrency=1` prevents cross-file database interference.
4. **Real JWT authentication.** A mock JWKS server provides real RS256 key pairs. Tests use actual JWT tokens validated by the production `jwt-auth` plugin.
5. **Fastify `inject()` for HTTP.** No real HTTP server is started -- Fastify's `inject()` simulates requests in-process.

## Test Directory Structure

```
apps/api/src/
  __tests__/
    plugins/
      jwt-auth.test.ts           # JWT middleware
    routes/
      activity.test.ts           # Activity feed
      agents.test.ts             # Agent CRUD
      approvals.test.ts          # Approval workflow
      audit.test.ts              # Audit + export
      connections-integrated.test.ts  # OAuth connections
      credentials.test.ts        # Credential resolution
      dashboard.test.ts          # Dashboard summary
      policies.test.ts           # Policy engine
      templates.test.ts          # Allowlist templates
      tokens.test.ts             # Personal access tokens
      vault-implementation.test.ts    # Model A + B
      workspaces.test.ts         # Workspace CRUD
    services/
      policy-engine.test.ts      # Policy engine unit tests
    utils/
      ssrf-protection.test.ts    # IP validation
  test-helpers/
    mock-jwt.ts                  # JWKS server + JWT creation
    mock-oauth.ts                # OAuth provider mocks
    test-data.ts                 # Factory functions for test entities
```

## Running Tests

### Full Suite

```bash
cd apps/api

# Start test database, run migrations, execute all tests
bash run-tests.sh
```

### Individual Test File

```bash
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 \
  --test-force-exit 'src/__tests__/routes/policies.test.ts'
```

### Filtered by Test Name

```bash
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 \
  --test-force-exit --test-name-pattern="cursor" 'src/__tests__/routes/audit.test.ts'
```

### Test Database Management

```bash
pnpm test:db:up      # Start test DB container (port 5433)
pnpm test:db:down    # Stop test DB container
pnpm test:db:reset   # Reset test DB (drop and recreate)
```

## Test Infrastructure

### Test Database

A dedicated PostgreSQL 15 container runs on port **5433** (separate from the dev database on 5432):

- **Database:** `agenthifive_test`
- **Credentials:** `test` / `test_password`
- **Schema:** Applied via Drizzle `migrate-push` before tests run

### Mock JWKS Server

Each test file starts a real HTTP server serving a JWKS endpoint with dynamically generated RS256 keys:

```typescript
const mockJwks = await createMockJwksServer();
process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

const token = await mockJwks.createTestJwt({
  sub: "user-123",
  wid: workspaceId,
  roles: ["owner"],
  scp: ["connections:read"],
});
```

The production `jwt-auth` plugin fetches the JWKS from this URL and validates tokens identically to production.

### Factory Functions

Type-safe factory functions in `test-data.ts` create test entities with sensible defaults:

- `createTestWorkspace()` -- workspace with random UUID owner
- `createTestAgent(workspaceId)` -- agent with name and description
- `createTestConnection(workspaceId)` -- connection with encrypted tokens
- `createTestPolicy(agentId, connectionId)` -- policy with defaults

All factories accept `overrides` for customization.

## Writing New Tests

### Checklist

- [ ] Auth required (401 without token)
- [ ] Happy path (200/201 with valid data)
- [ ] Validation errors (400 for bad input)
- [ ] Not found (404 for missing entities)
- [ ] Authorization (403 for insufficient permissions)
- [ ] Workspace scoping (cannot access other workspace data)
- [ ] Edge cases (empty arrays, null values, boundary conditions)

### Key Patterns

:::warning Dynamic Route Imports
Routes must be imported with `await import()` **after** environment variables (`WEB_JWKS_URL`, `ENCRYPTION_KEY`) are set. This ensures the route module initializes with the correct environment.
:::

- **Module mocking:** Call `mock.module()` before importing the route to mock external dependencies like `undici` and OAuth connectors.
- **Drizzle ORM operators:** Use `eq()`, `lt()`, `and()` from `drizzle-orm` for all query conditions. Never mix raw SQL template tags with Drizzle `.where()` clauses.
- **UUID columns:** Use `randomUUID()` from `node:crypto` for all ID generation in tests.

## Integration Tests

The `integration-testing/` directory contains fully containerized end-to-end tests (planned):

- Real OAuth token refresh with test credentials
- Full request flow: Frontend to API to Provider
- Docker Compose with all services (web, api, postgres, nginx)
- Triggered by label or manual dispatch in CI
