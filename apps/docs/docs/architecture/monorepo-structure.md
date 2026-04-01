---
title: Monorepo Structure
sidebar_position: 3
sidebar_label: Monorepo Structure
description: Folder layout, directory conventions, and build tooling for the AgentHiFive monorepo.
---

# Monorepo Structure

AgentHiFive uses a pnpm workspace monorepo managed by Turborepo. Infrastructure runs in Docker Compose; application services run natively for fast HMR and debugging.

## Folder Tree

```
agenthifive/
├── package.json              # Root scripts (turbo build/dev/lint/typecheck/test)
├── pnpm-workspace.yaml       # Workspace: apps/* + packages/*
├── turbo.json                # Task pipeline and caching
├── tsconfig.base.json        # Shared compiler options
├── Makefile                  # Dev environment orchestration
├── docker-compose.yml        # Dev infrastructure (PostgreSQL, Nginx)
├── .env.example              # Environment variable template
│
├── apps/
│   ├── web/                  # Next.js -- user authentication and dashboard UI
│   │   └── src/
│   │       ├── app/                      # App Router routes
│   │       │   ├── (auth)/               #   Login, register, passkey flows
│   │       │   ├── (dashboard)/          #   Authenticated workspace pages
│   │       │   ├── api/                  #   Better Auth, token exchange, JWKS
│   │       │   └── layout.tsx
│   │       ├── components/
│   │       │   ├── ui/                   #   shadcn/ui primitives
│   │       │   └── features/             #   Feature-specific components
│   │       ├── lib/                      #   Auth config, API client, key loading
│   │       └── hooks/                    #   Custom React hooks
│   │
│   ├── api/                  # Fastify -- business logic, OAuth, policy engine
│   │   └── src/
│   │       ├── server.ts                 # Fastify entry point
│   │       ├── plugins/                  # Fastify plugins
│   │       │   └── auth-jwt/             #   JWT verification via JWKS
│   │       ├── modules/                  # Feature modules (routes + service per module)
│   │       │   ├── oauth/                #   OAuth flows (auth-code, device)
│   │       │   ├── connections/          #   Provider connection management
│   │       │   ├── policies/             #   Policy engine (Model B)
│   │       │   ├── proxy/                #   Model B brokered proxy
│   │       │   └── audit/                #   Audit logging
│   │       └── db/
│   │           ├── schema/               #   Drizzle table definitions
│   │           ├── migrations/           #   Generated migrations
│   │           └── index.ts              #   DB client + pool
│   │
│   ├── cli/                  # CLI (deferred -- post-MVP)
│   └── docs/                 # Docusaurus documentation site
│
├── packages/
│   ├── contracts/            # Shared types and Zod schemas
│   │   └── src/              #   common.ts, auth.ts, oauth.ts, policy.ts
│   ├── security/             # JWT and encryption interfaces
│   │   └── src/              #   jwt.ts, crypto.ts
│   └── oauth-connectors/     # Provider OAuth abstraction
│       └── src/              #   types.ts, capabilities.ts, providers/
│
├── infra/
│   └── nginx/
│       └── dev.conf          # Nginx config for local dev
│
└── integration-testing/      # Fully containerized test environment
    ├── .env.example
    ├── Makefile
    ├── docker-compose.yml    # Full stack: FE + BE + DB + Nginx (all in Docker)
    └── nginx/
        └── integration.conf
```

## Directory Conventions

| Directory | Convention |
|-----------|-----------|
| `apps/api/src/modules/` | **Module-per-feature** -- each module owns its routes, service logic, and types |
| `apps/web/src/app/` | **Next.js App Router** -- route groups `(auth)` and `(dashboard)` separate public and authenticated pages |
| `packages/*/src/` | Flat source with `index.ts` barrel export. No runtime HTTP logic in packages |
| `infra/` | Infrastructure config files only (Nginx, future K8s manifests) |
| `integration-testing/` | Isolated from dev -- own `.env.example`, own `docker-compose.yml`, own Makefile |

## Build Tooling

### pnpm Workspaces

```yaml title="pnpm-workspace.yaml"
packages:
  - "apps/*"
  - "packages/*"
```

All apps and packages are linked via pnpm workspaces. Internal dependencies use `workspace:*` protocol.

### Turborepo Pipeline

```json title="turbo.json"
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^lint"]
    },
    "typecheck": {
      "dependsOn": ["^typecheck"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": ["coverage/**"]
    }
  }
}
```

The `^` prefix means "run this task in dependencies first." For example, `turbo build` for `apps/api` first builds `packages/contracts` and `packages/security`.

### TypeScript Configuration

```json title="tsconfig.base.json"
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

Each app and package extends `tsconfig.base.json` and adds its own paths and output settings.

## Makefile Targets

The root `Makefile` orchestrates the dev environment. Infrastructure (PostgreSQL + Nginx) runs in Docker Compose; app services run natively.

| Command | Description |
|---------|-------------|
| `make init` | First-time setup: install deps, copy `.env.example`, create DB, run migrations |
| `make up` | Start infrastructure (PostgreSQL + Nginx via Docker Compose) |
| `make down` | Stop infrastructure (data preserved) |
| `make down-hard` | Stop infrastructure and remove volumes -- clean slate |
| `make dev` | Start all apps in dev mode (`turbo dev`) |
| `make dev-web` | Start Next.js only |
| `make dev-api` | Start Fastify only |
| `make build` | Build all packages (`turbo build`) |
| `make migrate` | Run Drizzle migrations |
| `make migrate-generate` | Generate migration from schema changes |
| `make db-reset` | Drop and recreate DB + re-run migrations |
| `make test` | Run unit tests |
| `make lint` | Run linter across all packages |
| `make typecheck` | Run TypeScript type checking |
| `make clean` | Stop everything, remove `node_modules`, clear build artifacts |
