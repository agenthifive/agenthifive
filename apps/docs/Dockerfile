# Stage 1: Install dependencies
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/docs/package.json apps/docs/

RUN pnpm install --frozen-lockfile

# Stage 2: Build
FROM node:24-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/docs/node_modules ./apps/docs/node_modules

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/docs/ apps/docs/

ARG DOCS_BASE_URL=/
ENV DOCS_BASE_URL=$DOCS_BASE_URL
RUN cd apps/docs && npx docusaurus build

# Stage 3: Serve static files with nginx
FROM nginx:alpine
COPY --from=builder /app/apps/docs/build /usr/share/nginx/html
COPY apps/docs/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
