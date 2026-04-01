# AgentHiFive Architecture

> **Last Updated:** 2026-02-06
> **Status:** Approved - Ready for Implementation
> **Architect Review:** ✅ Validated

---

## Table of Contents

- [Overview](#overview)
- [Core Principles](#core-principles)
- [Monorepo Structure](#monorepo-structure)
- [Module Boundaries](#module-boundaries)
- [Token Model](#token-model)
- [Endpoint Contracts](#endpoint-contracts)
- [Technology Stack](#technology-stack)
- [Development Environment & CI/CD](#development-environment--cicd)
- [Implementation Order](#implementation-order)
- [Package Details](#package-details)

---

## Overview

AgentHiFive uses a **monorepo architecture** with clear separation between:
- **User authentication** (apps/web - Better Auth)
- **Business logic & provider OAuth** (apps/api - Fastify)
- **Shared contracts** (packages/contracts)

**Pattern:** Backend-for-Frontend (BFF) with JWT token exchange

---

## Core Principles

1. **User identity auth stays in Next.js + Better Auth**
   - Email/password, social OAuth/OIDC, passkeys (production-ready)

2. **Provider connection OAuth stays in Fastify**
   - Uses `oauth4webapi` for both auth code and device flow

3. **API token verification in Fastify uses jose**
   - JWKS from apps/web via `createRemoteJWKSet` + `jwtVerify`

4. **Device polling follows RFC 8628**
   - Respects `interval`, handles `authorization_pending`, `slow_down`, stop conditions

---

## Monorepo Structure

```
agenthifive/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── Makefile              # Dev environment orchestration
├── docker-compose.yml    # Dev infrastructure (PostgreSQL, Nginx)
├── .env.example
├── .gitignore
│
├── apps/
│   ├── web/              # Next.js - User authentication & UI
│   │   └── src/
│   │       ├── app/                  # App Router routes
│   │       │   ├── (auth)/           #   Login, register, passkey
│   │       │   ├── (dashboard)/      #   Authenticated pages
│   │       │   ├── api/              #   Better Auth, token exchange, JWKS
│   │       │   └── layout.tsx
│   │       ├── components/
│   │       │   ├── ui/               #   shadcn/ui primitives
│   │       │   └── features/         #   Feature-specific components
│   │       ├── lib/                  #   Auth config, API client, key loading
│   │       └── hooks/                #   Custom React hooks
│   │
│   ├── api/              # Fastify - Business logic & OAuth
│   │   └── src/
│   │       ├── server.ts             # Fastify entry point
│   │       ├── plugins/              # Fastify plugins (auth-jwt, etc.)
│   │       ├── modules/              # Feature modules (routes + service per module)
│   │       │   ├── oauth/            #   OAuth flows (auth-code, device)
│   │       │   ├── connections/      #   Provider connection management
│   │       │   ├── policies/         #   Policy engine (Model B)
│   │       │   ├── proxy/            #   Model B brokered proxy
│   │       │   └── audit/            #   Audit logging
│   │       └── db/
│   │           ├── schema/           #   Drizzle table definitions
│   │           ├── migrations/       #   Generated migrations
│   │           └── index.ts          #   DB client + pool
│   │
│   └── cli/              # CLI (deferred — post-MVP)
│
├── packages/
│   ├── contracts/        # Shared types & Zod schemas
│   │   └── src/          #   common.ts, auth.ts, oauth.ts
│   ├── security/         # JWT & encryption interfaces
│   │   └── src/          #   jwt.ts, crypto.ts
│   └── oauth-connectors/ # Provider OAuth abstraction
│       └── src/          #   types.ts, capabilities.ts, providers/
│
├── infra/
│   └── nginx/
│       └── dev.conf      # Nginx config for local dev
│
└── integration-testing/  # Fully containerized test environment
    ├── .env.example
    ├── Makefile
    ├── docker-compose.yml
    └── nginx/
        └── integration.conf
```

**Convention:** The API uses **module-per-feature** — each module owns its routes, service logic, and types. The web app follows **Next.js App Router** conventions with route groups for auth/dashboard separation.

---

## Module Boundaries

### apps/web (Next.js)

**Owns:**
- Better Auth config and routes (`/api/auth/*`)
- User sessions (HttpOnly cookie)
- Passkey enrollment/login UX
- Social sign-in UX
- Token exchange endpoint for internal API token

**Exposes:**
- `GET /.well-known/jwks.json` - Public key for JWT verification
- `POST /api/internal/token/exchange` - Session → JWT exchange

**Must NOT:**
- Store provider refresh tokens for integrations
- Poll device flow
- Call provider token endpoints directly

---

### apps/api (Fastify)

**Owns:**
- Fastify business APIs
- JWT validation plugin (internal API JWT verification via JWKS)
- OAuth integration service (auth code flow with oauth4webapi)
- Encrypted token vault persistence (provider token sets)
- RBAC/scope authorization

**Exposes:**
- `/v1/*` - Business APIs
- `/v1/oauth/{provider}/start` - Web auth-code connect
- `/v1/oauth/{provider}/callback` - Web callback

**Must NOT:**
- Handle passkey ceremonies for app login
- Manage browser user sessions

---

### apps/cli (deferred — post-MVP)

> CLI deferred from MVP scope. The vault (web UI) handles all human interactions,
> and the REST API is available for programmatic access.

---

### packages/contracts

**Owns:**
- Zod schemas + TS types for all cross-service requests/responses
- JWT claim interfaces (`ApiAccessClaims`, `WorkspaceRole`, `Scope`)

**Must NOT:**
- Include runtime HTTP logic

---

### packages/security

**Owns:**
- JWT sign/verify utilities
- Token encryption helpers (AES-256-GCM envelope format)
- Key rotation helpers (kid, key versioning)

**Must NOT:**
- Know DB schema details

---

### packages/oauth-connectors

**Owns:**
- Provider metadata discovery and endpoint config
- oauth4webapi wrappers for:
  - Authorization-code exchange
  - Refresh
  - Revoke
  - Device authorization + polling strategy

**Must NOT:**
- Access web session state

---

## Token Model

### 1. Web Session Cookie (Better Auth)
- **Scope:** Browser only
- **Security:** HttpOnly, SameSite=Lax/Strict
- **Lifetime:** 30 days (configurable)
- **Contains:** Session ID (references DB)

### 2. Internal API JWT (issued by apps/web)
- **Scope:** Web UI → API calls
- **TTL:** 5 minutes
- **Audience:** `api`
- **Issuer:** `web`
- **Claims:** `{ sub, wid, roles, scp, sid }`
- **Verification:** JWKS from `/.well-known/jwks.json`

### 3. Provider Token Set (stored by apps/api)
- **Contents:** `access_token`, `refresh_token`, `expiry`, `provider_account_id`
- **Storage:** Encrypted at rest with key ID (AES-256-GCM)
- **Rotation:** Key versioning supported via `kid`

---

## Endpoint Contracts

### Web to API Token Exchange

```
POST /api/internal/token/exchange
```

**Input:** Session cookie
**Output:** `{ accessToken, expiresIn }`
**Validation:** Active session + workspace membership

---

---

## Fastify Auth Plugin Boundary

### Global preHandler (JWT Verification)

```typescript
fastify.addHook('preHandler', async (request, reply) => {
  // 1. Parse Authorization: Bearer
  // 2. Verify via jose.jwtVerify + remote JWKS from web
  // 3. Enforce iss, aud, allowed alg, expiry
  // 4. Attach request.auth = { sub, wid, roles, scopes }
});
```

### Per-Route Scope Guard

```typescript
{
  preHandler: requireScope('integrations:write')
}
```

**Note:** Fastify `preHandler` is the correct lifecycle point for auth.

---

## Model B Performance Strategy

Model B (brokered proxy) is the performance-critical hot path. Every request goes through:

```
Agent → Nginx → Fastify → Policy check → Decrypt token → Provider API → Process → Audit → Return
                              ~0.1ms         ~1ms          50-500ms       ~0.5ms    async
```

**The provider API call dominates latency.** Everything else must be fast and non-blocking.

### Multi-Replica State Management

All correctness-critical state is shared via PostgreSQL. Cookie-based sticky sessions are a **performance optimization only** — not a correctness requirement.

| Component | Approach | Rationale |
|-----------|----------|-----------|
| **JTI replay cache** | PostgreSQL table (`l_jti_replay_cache`) | Security-critical; PK constraint ensures atomic cross-replica replay detection |
| **SSE notifications** | LISTEN/NOTIFY | Cross-replica real-time push to dashboard subscribers |
| **Policy cache** | In-memory + LISTEN/NOTIFY invalidation | Sub-ms lookup; NOTIFY broadcasts invalidation to all replicas |
| **Rate limiting (IP)** | Per-replica (N × limit acceptable) | DDoS protection; per-agent limits are DB-backed in policy engine |

**Cookie-based sticky sessions:**

- Load balancers hash `ah5sid` cookie to pin clients to specific replicas
- Cookie set by Fastify on first request, expires after 30 days
- Optimizes Model B performance (avoids policy re-compilation on cache miss)
- Works with Nginx, Azure Front Door, and Envoy Gateway (K8s)

**Nginx upstream config:**
```nginx
upstream api {
    hash $cookie_ah5sid consistent;
    server fastify-1:4000;
    server fastify-2:4000;
    server fastify-3:4000;
}
```

**Failover:** If a replica dies, load balancer re-routes to another. Minor performance hit (policy cache miss) but no state loss — all critical state in PostgreSQL.

### Optimization Strategies

| Concern | Strategy |
|---------|----------|
| **Policy evaluation** | In-memory cache per replica, invalidated cross-replica via LISTEN/NOTIFY. Sub-ms lookup |
| **JTI replay protection** | PostgreSQL PK constraint. ~1-2ms latency; security-critical |
| **Token decryption** | AES-256-GCM via Node.js crypto (~1ms). No optimization needed |
| **Provider API calls** | HTTP keep-alive + connection pooling via `undici` (built into Node.js 24). Reuse TCP connections to Google/Microsoft |
| **Audit logging** | **Async** — write audit event after response is sent (`reply.then()`). Never block the response |
| **SSE push** | LISTEN/NOTIFY broadcasts to all replica subscribers. ~10-50ms cross-replica delivery |
| **PostgreSQL pooling** | `postgres` (porsager/postgres) with configured pool size. Connection reuse across requests |

### Why No Redis

- LISTEN/NOTIFY handles cross-replica messaging natively
- JTI cache in DB: simple PK constraint, ~1-2ms latency (dominated by 50-500ms provider calls)
- In-memory policy cache + NOTIFY invalidation is faster than Redis (no network hop for reads)
- PostgreSQL is the single source of truth for all persistent and semi-persistent state
- One fewer service to deploy, monitor, and secure

---

## Data Ownership

| Data | Owner | Notes |
|------|-------|-------|
| `users`, `sessions`, `accounts` | `apps/web` | Better Auth tables |
| `oauth_connections`, `oauth_token_sets` | `apps/api` | Provider integrations |
| `oauth_device_requests` | `apps/api` | Device flow state |
| `audit_events` | `apps/api` | Audit trail |

**Rule:** No module writes another module's tables directly.

---

## Technology Stack

### Frontend (apps/web)
- **Framework:** Next.js 16 (Active LTS)
- **Auth:** Better Auth (passkeys, social, email/password)
- **UI:** shadcn/ui + Tailwind CSS 4.x
- **State:** TanStack Query v5
- **Forms:** React Hook Form + Zod 4.x

### Backend (apps/api)
- **Runtime:** Node.js 24 (Active LTS)
- **Framework:** Fastify 5.x
- **OAuth:** oauth4webapi (auth code flow with PKCE)
- **JWT:** jose (sign/verify with JWKS)
- **ORM:** Drizzle ORM
- **Validation:** Zod 4.x

### Database
- **Primary:** PostgreSQL 15+ (all data: users, sessions, connections, audit, JTI replay cache)
- **Caching:** In-memory per replica with LISTEN/NOTIFY invalidation
- **Pub/Sub:** Native LISTEN/NOTIFY for SSE push and cache coherence

> **Note:** No Redis required. Cookie-based sticky sessions optimize performance;
> LISTEN/NOTIFY handles cross-replica state coordination. PostgreSQL is the single
> source of truth for all persistent and semi-persistent state.

### Monorepo
- **Package Manager:** pnpm 9.x
- **Build System:** Turborepo 2.x
- **Language:** TypeScript 5.7+

### Infrastructure & Deployment

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Containerization** | Docker 24+ | Standard, works everywhere |
| **Orchestration** | Kubernetes **1.33+** | Current support window (1.35/1.34/1.33) |
| **Simple Deployment** | Docker Compose v2 | Single-server self-hosted, dev environment |
| **Reverse Proxy** | **Nginx** | Battle-tested, high performance, fine-grained traffic control (rate limiting, sticky sessions, connection pooling) |
| **K8s Traffic Management** | **Gateway API** (Envoy Gateway) | Future-proof successor to Ingress, role-oriented config |
| **Observability** | OpenTelemetry + Prometheus + Grafana | Vendor-agnostic tracing, metrics, dashboards |
| **Logging** | Pino | Fast structured JSON logging for Node.js |

**Decisions and rationale:**

**Why Nginx:**
- Battle-tested at massive scale with proven performance characteristics
- Fine-grained traffic control: sticky sessions (critical for Model B), rate limiting, connection pooling
- More tuning knobs for production workloads
- Larger ecosystem of modules and broader ops team familiarity
- TLS via Let's Encrypt with certbot or acme.sh (well-documented)

**Why Gateway API over Ingress:**
- Kubernetes officially positions Gateway API as the successor to Ingress
- More expressive routing (HTTPRoute, TLSRoute, GRPCRoute)
- Role-oriented: infrastructure team manages Gateway, app team manages HTTPRoute
- Supported by Envoy Gateway, Cilium, Istio, and others

**Why no PM2:**
- Redundant inside Docker/K8s (both handle restarts, scaling, health checks)
- Docker Compose restart policies and K8s pod management cover all our deployment targets
- For bare-metal edge cases, systemd is simpler and more standard

**Deployment topology:**

```
Docker Compose (dev / simple self-hosted):
┌──────────────────────────────────────────┐
│  Nginx (ports 80/443)                    │
│  ├─ app.example.com → Next.js :3000     │
│  └─ app.example.com/api/* → Fastify :4000│
│  (sticky sessions on /api/* via header)  │
├──────────────────────────────────────────┤
│  Next.js (apps/web)  :3000              │
│  Fastify  (apps/api) :4000              │
│  PostgreSQL           :5432              │
└──────────────────────────────────────────┘

Kubernetes (production):
┌──────────────────────────────────────────┐
│  Gateway (Envoy Gateway)                 │
│  ├─ HTTPRoute → web-service :3000       │
│  └─ HTTPRoute → api-service :4000       │
├──────────────────────────────────────────┤
│  web Deployment (Next.js)  replicas: 2  │
│  api Deployment (Fastify)  replicas: 3  │
│  PostgreSQL (StatefulSet or managed)     │
└──────────────────────────────────────────┘
```

### Security & Secrets

#### Secrets Management (OAuth credentials, API keys, environment variables)

| Environment | Solution | Notes |
|-------------|----------|-------|
| **Dev/Local** | `.env` files | Simple, fast iteration |
| **SaaS Production** | **AWS Secrets Manager** or **Azure Key Vault** | Managed, automatic rotation, audit |
| **Self-Hosted Production** | **HashiCorp Vault** or **SOPS** | Open-source, self-managed |
| **Self-Hosted (Simple)** | **Kubernetes Secrets** | Encrypted at rest |

**Critical:** ❌ **NEVER use .env files in production**

#### Key Management (Encryption keys for token vault)

| Environment | Solution | Pattern |
|-------------|----------|---------|
| **SaaS Production** | **AWS KMS** | Envelope encryption |
| **Self-Hosted Production** | **HashiCorp Vault Transit** | Encryption-as-a-service |
| **Self-Hosted (Simple)** | **age encryption** | File-based key rotation |
| **Dev/Local** | Hardcoded key | Dev only |

**Encryption:** AES-256-GCM for all provider tokens at rest (quantum-safe)

#### Key Rotation (documented from day one)

| What | Frequency | Method |
|------|-----------|--------|
| **KEK (master key)** | Every 365 days | KMS auto / Vault rotate / age manual |
| **DEK (workspace key)** | Every 90 days | Re-generate, re-encrypt tokens |
| **Emergency rotation** | Immediate | Force rotate + rewrap all |
| **JWT signing keys** | Every 90 days | New kid, keep old for verification |

**Critical:** Database schema includes `encryption_key_id` and `encryption_key_version` from day one.
Background rewrap job upgrades old ciphertexts to current key version.

#### Quantum Readiness

- ✅ **AES-256-GCM** (token encryption): Quantum-safe, no change needed
- ⚠️ **RSA/ECDSA** (JWT signing, passkeys): Vulnerable to Shor's algorithm, low practical risk (5-min TTL)
- ✅ **Algorithm agility**: Envelope format stores `alg`, signing alg is configurable, JWKS supports multiple keys
- **Migration path:** ML-DSA (FIPS 204) for signing when jose/WebAuthn support it

**Full details:** [SECURITY_AND_SECRETS.md](./Doc/Architecture/SECURITY_AND_SECRETS.md)

---

## Development Environment & CI/CD

### Local Development (VS Code)

Development workflow uses a **Makefile** at the repo root. Infrastructure runs in Docker Compose; app services run **natively** for fast HMR and VS Code debugging.

**Makefile targets:**

| Command | Description |
|---------|-------------|
| `make init` | First-time setup: install pnpm deps, copy `.env.example` → `.env`, create DB, run migrations |
| `make up` | Start infrastructure (PostgreSQL + Nginx via Docker Compose) |
| `make down` | Stop infrastructure (containers stop, data preserved) |
| `make down-hard` | Stop infrastructure **and remove volumes, networks, orphans** — clean slate |
| `make dev` | Start FE + BE in dev mode (`turbo dev`) |
| `make dev-web` | Start Next.js only |
| `make dev-api` | Start Fastify only |
| `make build` | Build all packages (`turbo build`) |
| `make migrate` | Run Drizzle migrations |
| `make migrate-generate` | Generate migration from schema changes |
| `make db-reset` | Drop and recreate DB + re-run migrations |
| `make clean` | Stop everything, remove `node_modules`, clear build artifacts |
| `make kill` | Force-stop all (`docker compose down` + kill node processes) |
| `make logs` | Tail infrastructure logs |
| `make lint` | Run linter across all packages |
| `make typecheck` | Run TypeScript type checking |
| `make test` | Run unit tests |

**Dev `docker-compose.yml`** (infrastructure only — FE/BE run natively):

```yaml
services:
  postgres:
    image: postgres:15
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      POSTGRES_USER: agenthifive
      POSTGRES_PASSWORD: dev-password
      POSTGRES_DB: agenthifive
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agenthifive"]
      interval: 5s
      timeout: 5s
      retries: 5

  nginx:
    image: nginx:alpine
    ports: ["8080:80"]
    volumes:
      - ./infra/nginx/dev.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

### CI/CD (GitHub Actions + Scaleway Container Registry)

**CI Pipeline (every PR):**
- Lint, typecheck, unit tests
- Runs on GitHub-hosted runners

**CD Pipeline (merge to main):**
- Build multi-stage Docker images for `apps/web` and `apps/api`
- Push to **Scaleway Container Registry** (`rg.fr-par.scw.cloud`)
- Deploy via K8s manifest apply or Helm upgrade

```yaml
# .github/workflows/cd.yml (key steps)
- name: Login to Scaleway Container Registry
  uses: docker/login-action@v2
  with:
    registry: rg.fr-par.scw.cloud
    username: ${{ secrets.SCALEWAY_ORG_ID }}
    password: ${{ secrets.SCALEWAY_API_SECRET_KEY }}

- name: Build and push API
  uses: docker/build-push-action@v5
  with:
    context: .
    file: apps/api/Dockerfile
    push: true
    tags: rg.fr-par.scw.cloud/${{ vars.SCW_NAMESPACE }}/api:${{ github.sha }}

- name: Build and push Web
  uses: docker/build-push-action@v5
  with:
    context: .
    file: apps/web/Dockerfile
    push: true
    tags: rg.fr-par.scw.cloud/${{ vars.SCW_NAMESPACE }}/web:${{ github.sha }}
```

> **Note on GitHub Actions speed:** GitHub-hosted runners can be slow for Docker builds.
> Add self-hosted or external workers as needed. Local Docker builds are an option for
> rapid iteration but should not replace CI for production deployments.

### Integration Testing

A dedicated `integration-testing/` folder at the repo root provides a **fully containerized** environment where FE and BE also run in Docker (unlike dev where they run natively).

```
integration-testing/
├── .env.example              # Integration-specific env vars (different URLs, ports)
├── Makefile                  # Setup/teardown for integration environment
├── docker-compose.yml        # Full stack: FE + BE + PostgreSQL + Nginx (all containerized)
└── nginx/
    └── integration.conf      # Nginx config for integration environment
```

**Key differences from dev:**

| Aspect | Dev | Integration |
|--------|-----|-------------|
| **FE/BE** | Native (`tsx watch`, `next dev`) | Docker containers (built images) |
| **URLs** | `localhost:3000`, `localhost:4000` | Configured via `.env` (e.g., `http://web:3000` internal) |
| **Database** | Shared dev DB | Isolated per run (fresh on each `make up`) |
| **Nginx config** | Dev proxy to native ports | Proxy to container hostnames |
| **Purpose** | Development + debugging | Automated testing, CI integration tests |

**Integration Makefile targets:**

| Command | Description |
|---------|-------------|
| `make up` | Build images and start full stack |
| `make down` | Stop all containers |
| `make down-hard` | Stop all, remove volumes/networks — clean slate |
| `make test` | Run integration test suite against the running stack |
| `make logs` | Tail all service logs |
| `make rebuild` | Force rebuild images and restart |

---

## Implementation Order

### Phase 1: Foundation
1. ✅ `packages/contracts` - Shared types and schemas
2. ✅ `packages/security` - JWT and crypto interfaces
3. ✅ `apps/web` - Better Auth + JWKS + token exchange endpoint
4. ✅ `apps/api` - JWT validation plugin + scope guard

### Phase 2: OAuth
5. ✅ `packages/oauth-connectors` - Provider abstraction
6. ✅ `apps/api` - OAuth auth-code connector
7. ~~`apps/api` - Device flow service + worker~~ (deferred — not needed for MVP)

---

## Package Details

See individual package README files for detailed implementation:
- [packages/contracts/README.md](./packages/contracts/README.md)
- [packages/security/README.md](./packages/security/README.md)
- [packages/oauth-connectors/README.md](./packages/oauth-connectors/README.md)
- [apps/web/README.md](./apps/web/README.md)
- [apps/api/README.md](./apps/api/README.md)
- [apps/cli/README.md](./apps/cli/README.md)

---

## Root Configuration Files

### package.json
```json
{
  "name": "agenthifive",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.1.0",
    "typescript": "^5.6.0"
  }
}
```

### pnpm-workspace.yaml
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### turbo.json
```json
{
  "$schema": "https://turbo.build/schema.json",
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

### tsconfig.base.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "types": ["node"]
  }
}
```

---

## Reference Implementation Files

For complete TypeScript interfaces and schemas, see:
- [ARCHITECTURE_CONTRACTS.md](./Doc/Architecture/ARCHITECTURE_CONTRACTS.md) - Full contract definitions
- [ARCHITECTURE_MODULES.md](./Doc/Architecture/ARCHITECTURE_MODULES.md) - Module-by-module breakdown

---

**Questions or need clarification?** Contact the architecture team or refer to the PRD: [tasks/prd-agenthifive.md](./tasks/prd-agenthifive.md)
