# Stage 1: Install dependencies
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/security/package.json packages/security/
COPY packages/oauth-connectors/package.json packages/oauth-connectors/

RUN pnpm install --frozen-lockfile

# Stage 2: Build shared packages
FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY --from=deps /app/ ./

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/contracts/ packages/contracts/
COPY packages/security/ packages/security/
COPY packages/oauth-connectors/ packages/oauth-connectors/
COPY apps/api/ apps/api/

# Build shared packages (API runs from TS source via tsx)
RUN pnpm turbo run build --filter='./packages/*'

# Stage 3: Production image
# Copy entire workspace to preserve pnpm symlink structure
FROM node:24-alpine AS runner

# Build metadata (passed from CD pipeline) — must be after FROM to be available in this stage
ARG BUILD_NUMBER=dev
ARG BUILD_DATE=unknown
ARG GIT_SHA=unknown

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 api

COPY --from=builder --chown=api:nodejs /app/ ./

# Remove test files and source maps to slim image
RUN rm -rf apps/api/src/__tests__ apps/api/src/test-helpers \
    packages/*/src packages/*/.turbo apps/api/.turbo 2>/dev/null || true

USER api

ENV NODE_ENV=production
ENV API_PORT=4000
ENV BUILD_NUMBER=$BUILD_NUMBER
ENV BUILD_DATE=$BUILD_DATE
ENV GIT_SHA=$GIT_SHA
ENV PATH="/app/apps/api/node_modules/.bin:${PATH}"
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:4000/health || exit 1

CMD ["tsx", "--import", "./apps/api/src/instrument.ts", "apps/api/src/server.ts"]
