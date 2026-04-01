# E2E Agent Auth Test Runner
# Lightweight container that seeds PostgreSQL, enrolls an agent via the real
# AH5 API, and runs integration test scenarios with node:test.
#
# Only built when running: make e2e (behind --profile e2e)

FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Copy workspace structure for pnpm install
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/security/package.json packages/security/
COPY packages/openclaw/package.json packages/openclaw/
COPY packages/oauth-connectors/package.json packages/oauth-connectors/

RUN pnpm install --frozen-lockfile

FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=deps /app/packages/security/node_modules ./packages/security/node_modules
COPY --from=deps /app/packages/openclaw/node_modules ./packages/openclaw/node_modules
COPY --from=deps /app/packages/oauth-connectors/node_modules ./packages/oauth-connectors/node_modules

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/contracts/ packages/contracts/
COPY packages/security/ packages/security/
COPY packages/openclaw/ packages/openclaw/
COPY packages/oauth-connectors/ packages/oauth-connectors/

# Build shared packages
RUN pnpm turbo run build --filter='./packages/*'

# Copy only the API source we need (DB schema, test helpers, drizzle config)
COPY apps/api/tsconfig.json apps/api/drizzle.config.ts apps/api/
COPY apps/api/src/db/ apps/api/src/db/
COPY apps/api/src/test-helpers/ apps/api/src/test-helpers/

# Copy e2e scripts
COPY integration-testing/e2e/ /app/integration-testing/e2e/

FROM node:24-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

# Copy everything from builder
COPY --from=builder /app/ ./

# Allow e2e scripts to resolve deps from api + openclaw node_modules
# (pnpm doesn't hoist — deps are scoped to their workspace package)
ENV NODE_PATH=/app/apps/api/node_modules:/app/packages/openclaw/node_modules:/app/node_modules
# tsx binary lives in apps/api/node_modules/.bin (pnpm scoped install)
ENV PATH="/app/apps/api/node_modules/.bin:/app/node_modules/.bin:${PATH}"

CMD ["tsx", "integration-testing/e2e/src/run.ts"]
