---
title: Development Guide
sidebar_position: 1
sidebar_label: Contributing
description: How to contribute to AgentHiFive, code style, PR process, and branch conventions.
---

# Development Guide

This guide covers how to set up your development environment, contribute code, and submit pull requests to AgentHiFive.

## Prerequisites

- **Node.js 24+** with **pnpm 9.x**
- **Docker 24+** (for PostgreSQL and Nginx in development)
- **VS Code** (recommended IDE)

## Repository Structure

AgentHiFive is a monorepo managed with **pnpm workspaces** and **Turborepo**:

```
AgentH5/
  apps/
    web/          # Next.js 16 frontend (dashboard)
    api/          # Fastify 5.x backend (API gateway)
    cli/          # CLI tool
    docs/         # Docusaurus documentation site
  packages/
    contracts/    # Shared Zod schemas and TypeScript types
    security/     # Encryption utilities
    sdk/          # Official TypeScript SDK
    oauth-connectors/  # OAuth provider adapters
    openclaw/     # OpenClaw Gateway plugin
    agenthifive-mcp/  # MCP server
  integration-testing/ # Fully containerized e2e tests
```

## Getting Started

```bash
# Clone the repository
git clone https://github.com/AgentHiFive/AgentH5.git
cd AgentH5

# Initialize the project (install dependencies, start Docker services, run migrations)
make init

# Start development servers (web + api running natively for fast HMR)
make dev

# Stop Docker services
make down
```

The `Makefile` at the repository root provides all common development commands. Run `make help` to see the full list.

## Code Style

- **TypeScript** across the entire codebase. Strict mode is enabled.
- **Zod 4.x** for runtime validation. Schemas live in `packages/contracts`.
- **Drizzle ORM** for database queries. No raw SQL in application code.
- **Fastify 5.x** with typed routes and JSON schema validation.
- **Tailwind 4.x** for frontend styling.

### Naming Conventions

| Context | Convention | Example |
|---------|-----------|---------|
| Files and directories | `kebab-case` | `jwt-auth.ts`, `oauth-connectors/` |
| TypeScript variables | `camelCase` | `workspaceId`, `auditEvents` |
| TypeScript types/interfaces | `PascalCase` | `ExecuteRequest`, `PolicySummary` |
| Database tables | `snake_case` with prefix | `t_connections`, `l_audit_events` |
| Database columns | `snake_case` | `workspace_id`, `created_at` |
| Environment variables | `SCREAMING_SNAKE_CASE` | `DATABASE_URL`, `WEB_JWKS_URL` |

## Branch Conventions

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code. Protected branch. |
| `<name>/<feature>` | Feature branches. Named `ralph/agenthifive-mvp`, `alice/policy-engine`, etc. |

All changes go through pull requests targeting `main`.

## Pull Request Process

1. Create a feature branch from `main`.
2. Make your changes with clear, atomic commits.
3. Ensure all checks pass locally: `pnpm lint`, `pnpm typecheck`, `pnpm test`.
4. Push your branch and open a pull request against `main`.
5. CI runs automatically: lint, typecheck, and test (see [CI/CD](./ci-cd.md)).
6. Request review from a team member.
7. After approval and passing CI, merge via squash-and-merge.

:::tip Before Submitting
Run `pnpm turbo run build --filter='./packages/*'` to verify that shared packages build correctly before opening a PR.
:::

## Common Makefile Commands

| Command | Description |
|---------|-------------|
| `make prereqs` | Install prerequisites (nvm, Node.js 24, pnpm, Docker) |
| `make init` | Full project setup (install, Docker up, migrate) |
| `make reset-env` | Reset `.env` from `core/.env.example` |
| `make dev` | Start all dev servers (web + api + admin) |
| `make dev-web` | Start only Next.js web (port 3000) |
| `make dev-api` | Start only Fastify API (port 4000) |
| `make dev-admin` | Start only Admin SPA (port 3002) |
| `make dev-docs` | Start Docusaurus (port 3001) |
| `make up` | Start PostgreSQL in Docker |
| `make down` | Stop Docker services |
| `make down-hard` | Stop and remove Docker volumes |
| `make logs` | Tail Docker logs |
| `make prod` | Build and start production stack |
| `make prod-build` | Rebuild production images |
| `make prod-down` | Stop production stack |
| `make prod-logs` | Tail production logs |
| `make build` | Build all packages and apps |
| `make migrate` | Run database migrations |
| `make migrate-generate` | Generate a new migration |
| `make db-reset` | Drop and recreate the database |
| `make psql` | Connect to PostgreSQL shell |
| `make dummydata` | Seed example data |
| `make lint` | Run linter |
| `make typecheck` | Run TypeScript checks |
| `make test` | Run tests |
| `make rebase` | Bump core submodule to latest public repo |
| `make clean` | Remove all build artifacts and node_modules |
| `make kill` | Stop everything |

## Next Steps

- [Testing](./testing.md) -- test architecture, patterns, and how to run tests.
- [Database](./database.md) -- Drizzle ORM patterns and naming conventions.
- [CI/CD](./ci-cd.md) -- GitHub Actions pipelines for continuous integration and deployment.
