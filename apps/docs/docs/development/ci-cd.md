---
title: CI/CD
sidebar_position: 4
sidebar_label: CI/CD
description: GitHub Actions CI and CD pipelines for AgentHiFive, including lint, typecheck, test, Docker build, and Azure deployment.
---

# CI/CD

AgentHiFive uses **GitHub Actions** for continuous integration and continuous deployment. The CI pipeline runs on every pull request and push to `main`. The CD pipeline builds Docker images and deploys to Azure on manual dispatch.

## CI Pipeline

**Workflow:** `.github/workflows/ci.yml`
**Triggers:** Push to `main`, pull requests targeting `main`, and manual dispatch (`workflow_dispatch`)
**Concurrency:** Grouped by ref with cancel-in-progress enabled

### Jobs

The CI pipeline runs one job: **lint-typecheck-test** (CI with PostgreSQL). The job has five stages:

```
Install --> Build Packages --> Apply Migrations --> Lint + Typecheck --> Test
```

### Stages

#### 1. Install Dependencies

```yaml
- uses: pnpm/action-setup@v4
- uses: actions/setup-node@v4
  with:
    node-version: 24
    cache: pnpm
- run: pnpm install --frozen-lockfile
```

Dependencies are installed with `--frozen-lockfile` to ensure reproducible builds. The pnpm cache is stored between runs for faster installs.

#### 2. Build Shared Packages

```yaml
- run: pnpm turbo run build --filter='./core/packages/*'
```

Shared packages (`contracts`, `security`, `sdk`, `oauth-connectors`) are built before linting or testing, since apps import from their build output.

#### 3. Apply Migrations

```yaml
- run: pnpm --filter @agenthifive/api run migrate-apply
```

Migration files are applied to the test database.

#### 4. Lint and Typecheck

```yaml
- run: pnpm turbo run lint
- run: pnpm turbo run typecheck
```

These commands run across the entire monorepo via Turborepo.

#### 5. Test (core)

```yaml
- run: pnpm turbo run test
  env:
    DATABASE_URL: postgresql://test:test_password@localhost:5433/agenthifive_test
```

Tests run against a PostgreSQL 15 service container provisioned by GitHub Actions:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    env:
      POSTGRES_DB: agenthifive_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test_password
    ports:
      - 5433:5432
    options: >-
      --health-cmd "pg_isready -U test -d agenthifive_test"
      --health-interval 2s
      --health-timeout 5s
      --health-retries 10
```

### Timeout

The CI job has a 15-minute timeout to prevent hung builds from consuming runner minutes.

## CD Pipeline

**Workflow:** `.github/workflows/cd.yml`
**Triggers:** Manual dispatch (`workflow_dispatch`)
**Concurrency:** Grouped by ref, cancel-in-progress **disabled** (deployments should complete)

### Overview

The CD pipeline builds Docker images and static SPAs, then deploys to the **Azure integration environment**. Authentication uses **OIDC federation** (no stored credentials).

### Architecture

```
Build Phase (parallel):
  ├── Build API Image → Push to Azure Container Registry (acrah5.azurecr.io)
  ├── Build Web SPA → Upload artifact
  ├── Build Admin SPA → Upload artifact
  └── Build Docs → Upload artifact

Deploy Phase (sequential):
  1. Update migration job image → Run DB migration
  2. Update API container app revision → Wait for healthy
  3. Upload Web SPA to Azure Storage
  4. Upload Docs to Azure Storage
  5. Upload Admin SPA to Azure Storage
```

### Authentication

```yaml
- uses: azure/login@v2
  with:
    client-id: ${{ vars.AZURE_CLIENT_ID }}
    tenant-id: ${{ vars.AZURE_TENANT_ID }}
    subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
- run: az acr login --name acrah5
```

:::info Required Variables
Three **repository variables** (not secrets) must be configured in GitHub:
- `AZURE_CLIENT_ID` — Service principal client ID (OIDC federation)
- `AZURE_TENANT_ID` — Azure AD tenant ID
- `AZURE_SUBSCRIPTION_ID` — Azure subscription ID

No stored secrets are needed — OIDC federation handles authentication.
:::

### Build and Push Images

The API Docker image is built and tagged with both the commit SHA and `latest`:

| Service | Dockerfile | Image |
|---------|-----------|-------|
| API | `apps/enterprise-api/Dockerfile` | `acrah5.azurecr.io/api` |

```yaml
- uses: docker/build-push-action@v5
  with:
    context: .
    file: apps/enterprise-api/Dockerfile
    push: true
    tags: |
      acrah5.azurecr.io/api:${{ github.sha }}
      acrah5.azurecr.io/api:latest
    build-args: |
      BUILD_NUMBER=${{ env.BUILD_NUMBER }}
      BUILD_DATE=${{ env.BUILD_DATE }}
      GIT_SHA=${{ env.GIT_SHA }}
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

Web, Docs, and Admin SPAs are built as static exports and uploaded to Azure Storage accounts (not containerized).

### Deploy to Integration

The deploy job runs after all builds succeed:

1. **Database migration** — Updates the Azure Container Apps migration job with the new image and runs it. Polls for completion (max 5 min).
2. **API revision** — Updates the Azure Container Apps API service with the new image. Waits for the revision to report healthy.
3. **SPA uploads** — Uploads Web, Docs, and Admin static exports to their respective Azure Storage `$web` containers.

### Promotion

A separate **promote workflow** (`.github/workflows/promote.yml`) promotes a successful integration build to staging or production without rebuilding.

### Timeout

Individual jobs have timeouts: 20 min (API build), 15 min (SPA builds), 15 min (deploy).

## Local Equivalents

| CI Step | Local Command |
|---------|---------------|
| Install | `pnpm install` |
| Build packages | `pnpm turbo run build --filter='./core/packages/*'` |
| Lint | `pnpm lint` |
| Typecheck | `pnpm typecheck` |
| Test | `cd apps/api && bash run-tests.sh` |
| Docker build | `docker build -f apps/enterprise-api/Dockerfile .`  |
