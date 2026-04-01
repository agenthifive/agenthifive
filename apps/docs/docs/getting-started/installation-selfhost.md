---
title: Self-Host Setup
sidebar_position: 4
sidebar_label: Self-Host Setup
description: Deploy the full AgentHiFive stack on your own infrastructure — Node.js or Docker Compose.
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Self-Host Setup

Run the complete AgentHiFive stack on your own infrastructure. You get full control over data storage, encryption keys, and network topology.

<Tabs>
<TabItem value="nodejs" label="Node.js" default>

## Prerequisites

- **Node.js 24+** (via nvm)
- **pnpm 9.x** (via corepack)
- **Docker 24+** (for PostgreSQL)
- **Git**

## Step 1: Clone the Repository

```bash
git clone https://github.com/AH5-AgentHiFive/AgentH5.git
cd AgentH5
```

## Step 2: Install Prerequisites

The `prereqs` target installs nvm, Node.js 24, pnpm, and Docker if they are not already present:

```bash
make prereqs
```

After it completes, open a new terminal so nvm is loaded in your shell.

## Step 3: Configure Environment Variables

```bash
cp .env.example .env
```

Open `.env` and set the values below. At minimum you need `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` — everything else has working defaults for local development.

### Key Environment Variables

| Variable | Purpose | Default / How to Generate |
|----------|---------|---------------------------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://agenthifive:dev-password@localhost:5432/agenthifive` |
| `BETTER_AUTH_SECRET` | Session signing secret | Generate: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | AES-256-GCM key (64 hex chars) | Generate: `openssl rand -hex 32` |
| `WEB_URL` | Public-facing URL of the web app | `http://localhost:3000` |
| `WEB_JWKS_URL` | JWKS endpoint for JWT verification (keep internal) | `http://localhost:4000/.well-known/jwks.json` |
| `API_PORT` | Fastify listen port | `4000` |
| `GOOGLE_CLIENT_ID` | Google OAuth app credentials (for vault connections) | Optional — users can add their own via Settings |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app secret | Optional |
| `MICROSOFT_CLIENT_ID` | Microsoft OAuth app credentials (for vault connections) | Optional |
| `MICROSOFT_CLIENT_SECRET` | Microsoft OAuth app secret | Optional |
| `AUTH_GOOGLE_CLIENT_ID` | Google credentials for social login button | Optional |
| `AUTH_GOOGLE_CLIENT_SECRET` | Google secret for social login button | Optional |
| `AUTH_MICROSOFT_CLIENT_ID` | Microsoft credentials for social login button | Optional |
| `AUTH_MICROSOFT_CLIENT_SECRET` | Microsoft secret for social login button | Optional |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (for Telegram connections) | Optional |

:::warning Production secrets
Never use the example values (`dev-only-secret-change-in-production`, `0000...`) in production. Always generate cryptographically random secrets.
:::

## Step 4: Initialize

This installs dependencies, builds shared packages, starts PostgreSQL in Docker, and runs database migrations:

```bash
make init
```

## Step 5: Start Development Servers

```bash
make dev
```

This starts:
- **Web dashboard** on [http://localhost:3000](http://localhost:3000)
- **API server** on [http://localhost:4000](http://localhost:4000)

Open your browser to [http://localhost:3000](http://localhost:3000) and create your first account.

:::tip Background mode
For headless servers or long-running sessions, use `make dev-ul` to run in the background. View logs with `make dev-ul-logs` and stop with `make dev-ul-stop`.
:::

### Makefile Command Reference

| Command | Description |
|---------|-------------|
| `make init` | First-time setup: install deps, build packages, start DB, migrate |
| `make dev` | Start web (`:3000`) + API (`:4000`) dev servers |
| `make dev-ul` | Start dev servers in background (survives SSH disconnect) |
| `make build` | Build all packages and apps |
| `make test` | Run full test suite |
| `make lint` | Run linter |
| `make typecheck` | Run TypeScript type checks |
| `make migrate` | Push schema changes to the database |
| `make migrate-generate` | Generate a new migration file |
| `make db-reset` | Drop and recreate the database, then re-migrate |
| `make up` | Start Docker services (PostgreSQL) |
| `make down` | Stop Docker services |
| `make down-hard` | Stop Docker services and delete volumes |
| `make dummydata` | Seed example agent and permission requests |
| `make psql` | Open a PostgreSQL shell |
| `make clean` | Remove all build artifacts and node_modules |

</TabItem>
<TabItem value="docker" label="Docker Compose">

## Prerequisites

- **Docker 24+**
- **Docker Compose v2**

## Step 1: Clone the Repository

```bash
git clone https://github.com/AH5-AgentHiFive/AgentH5.git
cd AgentH5
```

## Step 2: Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and set production values. See the environment variable table in the Node.js tab for the full list. At minimum, generate real secrets:

```bash
# Generate secrets and append to .env
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
```

Update the database URL to point to the Compose service name:

```bash
# In .env, change localhost to postgres (the Docker service name):
DATABASE_URL=postgresql://agenthifive:change-me-in-production@postgres:5432/agenthifive
```

Set the public-facing URLs to match your domain (or `http://localhost:8080` for local testing):

```bash
NEXT_PUBLIC_WEB_URL=https://ah5.yourcompany.com
NEXT_PUBLIC_API_URL=https://ah5.yourcompany.com/v1
WEB_URL=https://ah5.yourcompany.com
WEB_JWKS_URL=http://api:4000/.well-known/jwks.json
```

:::info WEB_JWKS_URL stays internal
`WEB_JWKS_URL` is used server-side for JWT verification. Point it to the internal Docker service name (`http://api:4000`), not the public URL. This avoids exposing the JWKS endpoint and eliminates a network round-trip through the reverse proxy.
:::

## Step 3: Create docker-compose.prod.yml

Create a `docker-compose.prod.yml` in the repo root:

```yaml title="docker-compose.prod.yml"
services:
  postgres:
    image: postgres:15
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: agenthifive
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-change-me-in-production}
      POSTGRES_DB: agenthifive
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U agenthifive"]
      interval: 5s
      timeout: 5s
      retries: 5

  api:
    build:
      context: .
      dockerfile: apps/api/Dockerfile
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file: .env
    environment:
      DATABASE_URL: postgresql://agenthifive:${POSTGRES_PASSWORD:-change-me-in-production}@postgres:5432/agenthifive
      WEB_JWKS_URL: http://localhost:4000/.well-known/jwks.json
      API_BIND_HOST: "0.0.0.0"
      NODE_ENV: production
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:4000/health"]
      interval: 10s
      timeout: 5s
      start_period: 10s
      retries: 3

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
    volumes:
      - ./infra/nginx/selfhost.conf:/etc/nginx/nginx.conf:ro
      - web-static:/var/www/html:ro
    depends_on:
      api:
        condition: service_healthy

volumes:
  pgdata:
  web-static:
```

:::note About the web SPA
AgentHiFive's web dashboard is a static SPA (exported Next.js). In production, Nginx serves the pre-built static files directly. You need to build the SPA and copy the output into the `web-static` volume. See Step 4 below.
:::

## Step 4: Build and Start

```bash
# Build the API image
docker compose -f docker-compose.prod.yml build api

# Build the web SPA (requires Node.js + pnpm locally, or use a build container)
pnpm install --frozen-lockfile
pnpm turbo build --filter=@agenthifive/web

# Copy built SPA into the volume (one-time, repeat after web changes)
docker compose -f docker-compose.prod.yml up -d nginx
docker cp apps/web/out/. $(docker compose -f docker-compose.prod.yml ps -q nginx):/var/www/html/

# Start the full stack
docker compose -f docker-compose.prod.yml up -d
```

## Step 5: Run Initial Migration

```bash
docker compose -f docker-compose.prod.yml exec api \
  pnpm --filter @agenthifive/api run migrate
```

## Step 6: Create an Nginx Config

Create `infra/nginx/selfhost.conf` (or adapt the production template at `infra/nginx/prod.conf.template`):

```nginx title="infra/nginx/selfhost.conf"
events {
    worker_connections 2048;
}

http {
    include mime.types;
    default_type application/octet-stream;

    sendfile on;
    tcp_nopush on;
    keepalive_timeout 65;
    client_max_body_size 10m;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml text/javascript;

    upstream api {
        server api:4000;
    }

    server {
        listen 80;
        server_name _;

        # API routes -> Fastify
        location /api/ {
            proxy_pass http://api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 60s;
        }

        location /v1/ {
            proxy_pass http://api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 65s;
        }

        # Vault execute — higher timeout for long-poll providers
        location /v1/vault/execute {
            proxy_pass http://api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 120s;
            proxy_send_timeout 120s;
        }

        # JWKS endpoint -> Fastify
        location /.well-known/ {
            proxy_pass http://api;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        # Static SPA — served from built Next.js export
        location / {
            root /var/www/html;
            try_files $uri $uri/ /index.html;
        }

        # Immutable hashed assets — long cache
        location /_next/static/ {
            root /var/www/html;
            expires 365d;
            add_header Cache-Control "public, max-age=31536000, immutable";
        }
    }
}
```

## Step 7: Verify

Open your browser to [http://localhost:8080](http://localhost:8080) (or your configured domain) and create your first account.

Check the API health endpoint:

```bash
curl http://localhost:8080/v1/health
```

</TabItem>
</Tabs>

## Connecting OpenClaw

Once your self-hosted instance is running, install the AgentHiFive plugin for OpenClaw:

```bash
openclaw plugins install @agenthifive/openclaw
npx @agenthifive/openclaw-setup
```

When prompted for the **base URL**, enter your self-hosted URL (e.g., `https://ah5.yourcompany.com` or `http://localhost:8080` for local testing).

The setup will:

1. Ask for an **enrolment key** (bootstrap secret) — generate one from the dashboard (**Agents → your agent → Bootstrap Secret**)
2. Register an ES256 key pair with AgentHiFive
3. Fetch your vault connections and configure the LLM provider
4. Install the plugin and apply integration patches
5. Verify the installation

See the [Setup CLI Reference](./setup-cli.md) for the full list of options and advanced usage.

Verify the connection by starting the TUI:

```bash
openclaw tui
```

You should see:
```
[plugins] AgentHiFive: token refreshed (prefix: ah5t...)
```

## Production Checklist

Before exposing your instance to the internet:

- [ ] **TLS enabled** — terminate HTTPS at a reverse proxy (Nginx, Caddy, or a cloud load balancer). See the [production Nginx template](https://github.com/AH5-AgentHiFive/AgentH5/blob/main/infra/nginx/prod.conf.template) for a full TLS configuration with Let's Encrypt.
- [ ] **Strong secrets** — `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` generated with `openssl rand -hex 32`, not dev defaults
- [ ] **Database TLS** — `DATABASE_URL` includes `?sslmode=require` (or `verify-full` if your provider supports it)
- [ ] **Internal JWKS** — `WEB_JWKS_URL` points to an internal address (e.g., `http://api:4000/.well-known/jwks.json`), not exposed publicly
- [ ] **OAuth credentials configured** — Google and/or Microsoft app credentials set for the providers you need
- [ ] **Firewall rules** — only port 443 (HTTPS) exposed publicly; database port (5432) blocked from external access
- [ ] **Backups** — PostgreSQL automated backups configured (pg_dump cron, cloud provider snapshots, or WAL archiving)
- [ ] **Monitoring** — set `SENTRY_DSN` for error tracking, or connect your preferred observability stack

## Next Steps

- [Quickstart](./quickstart.md) — End-to-end walkthrough: create an agent, bind a policy, make a vault call
- [Architecture](/architecture/) — System design, request flow, and execution models
