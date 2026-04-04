---
sidebar_position: 6
title: Changelog & Upgrades
description: Version history, upgrade procedures, and breaking change notices
---

# Changelog & Upgrades

## Current Versions

All packages live in the `packages/` directory of the monorepo and are published independently.

| Package | npm Name | Version | Description |
|---------|----------|---------|-------------|
| `openclaw` | `@agenthifive/agenthifive` | `0.4.6` | OpenClaw Gateway plugin |
| `sdk` | `@agenthifive/sdk` | `0.1.0` | Official TypeScript SDK |
| `agenthifive-mcp` | `agenthifive-mcp` | `0.1.0` | MCP server (stdio transport) |
| `openclaw-setup` | `@agenthifive/openclaw-setup` | `0.2.18` | Setup CLI (`ah5-setup`) |
| `contracts` | `@agenthifive/contracts` | `0.1.0` | Shared Zod schemas and TypeScript types |

## Versioning Policy

- **Monorepo, independent versions.** Each package in `packages/` is versioned independently. A bump to `@agenthifive/contracts` does not automatically bump `@agenthifive/sdk`.
- **Semantic versioning (semver).** All packages follow `MAJOR.MINOR.PATCH`. While packages are below `1.0.0`, minor bumps may include breaking changes.
- **Workspace protocol.** Internal dependencies use `workspace:*` in `package.json`, so they always resolve to the local copy during development. Published packages pin exact versions.
- **No backwards compatibility guarantee yet.** The project is pre-1.0. APIs, schemas, and interfaces may change freely between releases. Always read the upgrade notes before pulling.

## Upgrade Guide

When pulling the latest version of the monorepo, follow these steps in order:

### 1. Pull latest code

```bash
git pull origin main
git submodule update --init --recursive
```

### 2. Install dependencies

```bash
pnpm install
```

This also rebuilds any workspace links between packages.

### 3. Run database migrations

```bash
make migrate
```

Migrations use `drizzle-kit push` against your local database. If you need a clean slate:

```bash
make db-reset   # Drops and recreates the database, then migrates
```

### 4. Rebuild all packages

```bash
make build
```

This runs `turbo build` across the full monorepo. Shared packages (`contracts`, `security`, `sdk`) are built before apps that depend on them.

### 5. Restart services

```bash
make dev        # Development: starts web (:3000) + api (:4000)
```

For production deployments, restart the relevant systemd units or container services after the build completes.

## Breaking Changes Checklist

After every update, check the following areas for breaking changes:

### Database migrations

Always run `make migrate` after pulling new code. Schema changes are common and skipping migrations will cause runtime errors. Check `apps/api/src/db/schema/` for new or modified table definitions.

### Environment variable changes

Compare your `.env` file against the example:

```bash
diff .env .env.example
```

New required variables will cause startup failures if missing. Pay attention to any variables related to auth (`BETTER_AUTH_SECRET`, `WEB_JWKS_URL`) and database (`DATABASE_URL`).

### API contract changes

The `@agenthifive/contracts` package defines all shared Zod schemas and TypeScript types. If this package has been updated, downstream consumers (SDK, API routes, MCP server) may have changed their request/response shapes.

Review changes with:

```bash
git diff HEAD~5 -- packages/contracts/src/
```

### Plugin config schema changes

The OpenClaw plugin (`@agenthifive/agenthifive`) and setup CLI (`@agenthifive/openclaw-setup`) may introduce new required configuration fields. After updating, re-run the setup flow if your plugin stops registering correctly:

```bash
ah5-setup
```

### OpenClaw peer dependency

The `@agenthifive/agenthifive` plugin declares a peer dependency on `openclaw`. If the required OpenClaw version range changes, you may need to update your OpenClaw Gateway installation to match.

## Recent Changes

For detailed change history, consult the git log:

```bash
# Last 30 commits with summary
git log --oneline -30

# Changes to a specific package
git log --oneline -- packages/contracts/

# Full diff for recent changes
git log -p -5
```

Recent work has focused on:

- OpenClaw channel lifecycle and reconnection reliability
- OpenClaw setup flow improvements
- Authentication path corrections (Better Auth)
- Azure deployment and promotion workflow hardening
- Infrastructure improvements (Front Door, storage, custom domains)
- Docker build fixes (tsconfig copying, postinstall handling)
- Monitoring improvements (latency metric alerting)

:::tip
This project does not yet maintain a formal CHANGELOG file. The git history is the source of truth for all changes. Once the project reaches 1.0, a structured changelog will be introduced.
:::
