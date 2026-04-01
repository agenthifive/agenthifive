---
title: Architecture Overview
sidebar_position: 1
sidebar_label: Overview
description: High-level system architecture for AgentHiFive -- apps, packages, core principles, and request flow.
---

# Architecture Overview

AgentHiFive is an authority delegation platform for AI agents. It uses a **monorepo architecture** with clear separation between user authentication, business logic, and shared contracts.

## System Components

| Component | Technology | Responsibility |
|-----------|-----------|----------------|
| **apps/web** | Next.js 16 | User dashboard, Better Auth (email/password, social OAuth, passkeys), JWKS endpoint, token exchange |
| **apps/api** | Fastify 5 | Business APIs, provider OAuth (oauth4webapi), policy engine, brokered proxy (Model B), audit logging |
| **packages/contracts** | TypeScript + Zod | Shared types, Zod schemas, JWT claim interfaces |
| **packages/security** | TypeScript | JWT sign/verify utilities, AES-256-GCM envelope encryption, key rotation helpers |
| **packages/oauth-connectors** | TypeScript | Provider OAuth abstraction over oauth4webapi (auth code, refresh, revoke) |

## Core Principles

1. **Workspace-scoped multi-tenancy** -- every API request is scoped to a workspace via the `wid` JWT claim. Data isolation is enforced at the query level.

2. **JWT auth with JWKS** -- the web app issues short-lived JWTs (5-minute TTL). The API verifies them using a remote JWKS endpoint (`/.well-known/jwks.json`) via `jose`.

3. **Policy-first execution** -- every proxied request (Model B) passes through the policy engine before reaching the provider API. Rules are compiled once and cached in-memory per replica.

4. **Async audit logging** -- audit events are written after the response is sent (`reply.then()`). Logging never blocks the hot path.

5. **No Redis** -- PostgreSQL LISTEN/NOTIFY handles cross-replica messaging (SSE push, policy cache invalidation). Cookie-based sticky sessions optimize performance. PostgreSQL is the single source of truth.

## Request Flow

```
Browser                  apps/web (Next.js)              apps/api (Fastify)
  |                           |                                |
  |-- login ----------------->|                                |
  |   (Better Auth session)   |                                |
  |                           |                                |
  |-- dashboard action ------>|                                |
  |   (session cookie)        |-- POST /api/internal/token/exchange
  |                           |   (validate session, issue JWT)|
  |                           |                                |
  |                           |-- GET/POST /v1/* ------------->|
  |                           |   Authorization: Bearer <JWT>  |
  |                           |                                |-- verify JWT (JWKS)
  |                           |                                |-- evaluate policy rules
  |                           |                                |-- decrypt provider token
  |                           |                                |-- call provider API
  |                           |                                |-- filter response
  |                           |                                |-- async audit log
  |                           |<-- response -------------------|
  |<-- rendered UI ----------|                                |
```

## Agent Request Flow (Model B)

```
AI Agent                   Nginx                    apps/api (Fastify)        Provider API
  |                          |                            |                       |
  |-- POST /v1/proxy ------->|                            |                       |
  |   (Bearer JWT)           |-- cookie hash (ah5sid) --->|                       |
  |                          |                            |-- policy check (~0.1ms)
  |                          |                            |-- decrypt token (~1ms) |
  |                          |                            |-- forward request ---->|
  |                          |                            |   (50-500ms)           |
  |                          |                            |<-- provider response --|
  |                          |                            |-- response filter      |
  |                          |                            |-- async audit          |
  |<-- filtered response ----|<---------------------------|                       |
```

## Technology Stack

- **Runtime:** Node.js 24, TypeScript 5.7+
- **Frontend:** Next.js 16, shadcn/ui, Tailwind 4.x, TanStack Query v5
- **Backend:** Fastify 5.x, Drizzle ORM, Zod 4.x
- **Database:** PostgreSQL 15+ (no Redis)
- **Monorepo:** pnpm 9.x, Turborepo 2.x
- **Infrastructure:** Docker 24+, Nginx, Kubernetes 1.33+ (Gateway API with Envoy Gateway)
- **Encryption:** AES-256-GCM (quantum-safe), envelope encryption with key rotation

## Next Steps

- [Module Boundaries](./module-boundaries.md) -- what each app and package owns
- [Monorepo Structure](./monorepo-structure.md) -- folder layout and build tooling
- [Endpoint Contracts](./endpoint-contracts.md) -- TypeScript types and Zod schemas
- [Execution Models](./execution-models.md) -- Model A, B, and C comparison
- [Policy Engine](./policy-engine.md) -- declarative rule evaluation and response filtering
