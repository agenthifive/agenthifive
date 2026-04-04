---
sidebar_position: 5
title: Environment Variables
description: Complete reference of all configuration environment variables
---

# Environment Variables

Complete reference of every environment variable used by AgentHiFive. Variables are grouped by category. **Required** means the application will not start or the feature will not work without it; **Optional** means a sensible default is used when the variable is absent.

---

## Core Configuration

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `DATABASE_URL` | **Required** | — | PostgreSQL connection string. | `postgresql://agenthifive:secret@localhost:5432/agenthifive` |
| `API_PORT` | Optional | `8080` | Port the Fastify API server listens on. | `4000` |
| `API_BIND_HOST` | Optional | `0.0.0.0` | Host/IP address to bind the API server. Set to `127.0.0.1` on a VPS without a reverse proxy. | `127.0.0.1` |
| `WEB_URL` | Optional | `http://localhost:3000` | Origin of the web app. Used for CORS, JWT issuer, email links, and OAuth callback URLs. | `https://app.example.com` |
| `API_INTERNAL_URL` | Optional | — | Internal API URL (container-to-container). Added to the agent token audience allowlist so agents on a private network pass audience checks. | `http://api:4000` |
| `DOCS_INTERNAL_URL` | Optional | — | Internal URL of the Docusaurus docs site (used for reverse proxy routing). | `http://localhost:3001` |
| `NODE_ENV` | Optional | — | Node.js environment. When set to `production`, enables structured JSON logging, tighter rate limits, and secure cookies. | `production` |
| `LOG_LEVEL` | Optional | `info` | Pino log level for the API server (`fatal`, `error`, `warn`, `info`, `debug`, `trace`). | `debug` |

## URLs (Build-Time / Frontend)

These `NEXT_PUBLIC_*` variables are baked into the Next.js static build at compile time.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `NEXT_PUBLIC_WEB_URL` | **Required** | — | Public URL of the web app, used in client-side links and redirects. | `https://app.example.com` |
| `NEXT_PUBLIC_API_URL` | **Required** | — | API base URL as seen by the browser (typically through a reverse proxy). | `https://app.example.com/v1` |
| `NEXT_PUBLIC_DOCS_URL` | Optional | `/docs` | Documentation URL. In production this can be a separate subdomain. | `https://docs.example.com` |

## Authentication

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `BETTER_AUTH_SECRET` | **Required** | — | Secret used by Better Auth for session signing. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. | `a]3f9...` (64 hex chars) |
| `JWT_PRIVATE_KEY` | Optional | Auto-generated ephemeral key | PEM-encoded PKCS#8 private key for JWT signing. Required in production for stable JWKS across restarts. Can be base64-encoded. | `-----BEGIN PRIVATE KEY-----\nMIIE...` |
| `JWT_KID` | Optional | Random UUID | Key ID published in the JWKS endpoint. Set explicitly for key rotation. | `my-key-2025` |
| `JWT_SIGNING_ALG` | Optional | `RS256` | JWT signing algorithm (`RS256` or `ES256`). | `ES256` |
| `WEB_JWKS_URL` | **Required** | — | URL of the JWKS endpoint used by the API to verify JWTs. In Docker Compose this points to the internal API container. | `http://localhost:4000/.well-known/jwks.json` |

## Encryption

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | **Required** (env mode) | — | AES-256-GCM data encryption key (64 hex characters = 32 bytes). Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. | `0a1b2c...` (64 hex chars) |
| `ENCRYPTION_KEY_MODE` | Optional | `env` | Encryption key provider. `env` reads from `ENCRYPTION_KEY`; `azure-kv` unwraps a DEK from Azure Key Vault at startup. | `azure-kv` |
| `AZURE_KEY_VAULT_URI` | Required (azure-kv mode) | — | Azure Key Vault URI for DEK unwrapping. | `https://my-vault.vault.azure.net` |
| `AZURE_KV_KEK_NAME` | Optional | `data-encryption-kek` | Name of the Key Encryption Key in Azure Key Vault. | `data-encryption-kek` |
| `AZURE_KV_WRAPPED_DEK_SECRET` | Optional | `WRAPPED-DATA-KEY` | Name of the Key Vault secret containing the wrapped DEK. | `WRAPPED-DATA-KEY` |
| `AZURE_MANAGED_IDENTITY_CLIENT_ID` | Optional | — | Client ID of the Azure Managed Identity used to authenticate to Key Vault. When omitted, the default credential chain is used. | `12345678-abcd-...` |

## OAuth Providers (Social Login)

These configure social sign-in via Better Auth. The `AUTH_*` prefixed variants take precedence; the unprefixed variants (`GOOGLE_CLIENT_ID`, etc.) are used as fallbacks and also serve as **connection credentials** for the OAuth connector factory.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `AUTH_GOOGLE_CLIENT_ID` | Optional | — | Google OAuth client ID for social login. Falls back to `GOOGLE_CLIENT_ID`. | `123...apps.googleusercontent.com` |
| `AUTH_GOOGLE_CLIENT_SECRET` | Optional | — | Google OAuth client secret for social login. Falls back to `GOOGLE_CLIENT_SECRET`. | `GOCSPX-...` |
| `AUTH_MICROSOFT_CLIENT_ID` | Optional | — | Microsoft Entra ID client ID for social login. Falls back to `MICROSOFT_CLIENT_ID`. | `12345678-...` |
| `AUTH_MICROSOFT_CLIENT_SECRET` | Optional | — | Microsoft Entra ID client secret for social login. Falls back to `MICROSOFT_CLIENT_SECRET`. | `abc123~...` |
| `AUTH_MICROSOFT_TENANT_ID` | Optional | `common` | Microsoft tenant ID. Falls back to `MICROSOFT_TENANT_ID`. | `common` |
| `APPLE_CLIENT_ID` | Optional | — | Apple Sign In service ID. | `com.example.signin` |
| `APPLE_CLIENT_SECRET` | Optional | — | Apple Sign In client secret (JWT). | `eyJ...` |
| `FACEBOOK_CLIENT_ID` | Optional | — | Facebook Login app ID. | `123456789012345` |
| `FACEBOOK_CLIENT_SECRET` | Optional | — | Facebook Login app secret. | `abc123...` |

### Connection Credentials (OAuth Connector Factory)

Used by the server-side OAuth connector factory for token refresh and provider API calls. These are the unprefixed variants; they double as social login fallbacks when `AUTH_*` variants are not set.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Optional | — | Google OAuth client ID for connections. | `123...apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Optional | — | Google OAuth client secret for connections. | `GOCSPX-...` |
| `MICROSOFT_CLIENT_ID` | Optional | — | Microsoft OAuth client ID for connections. | `12345678-...` |
| `MICROSOFT_CLIENT_SECRET` | Optional | — | Microsoft OAuth client secret for connections. | `abc123~...` |
| `MICROSOFT_TENANT_ID` | Optional | `common` | Microsoft tenant ID for connections. | `common` |

## Agent Configuration

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `AGENT_TOKEN_TTL_SECONDS` | Optional | `7200` | Lifetime of agent access tokens in seconds (2 hours). | `900` |
| `AGENT_TOKEN_AUDIENCE` | Optional | API base URL (`http://localhost:4000`) | Expected `aud` claim in agent client assertions. Localhost and `WEB_URL` variants are auto-added. Falls back to `API_BASE_URL`. | `https://api.example.com` |
| `BOOTSTRAP_SECRET_TTL_HOURS` | Optional | `1` | Lifetime of bootstrap secrets in hours before they expire. | `24` |

## Email

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `EMAIL_PROVIDER` | Optional | `noop` | Email transport: `smtp` (any SMTP relay), `acs` (Azure Communication Services), `ethereal` (dev preview URLs), `noop` (log only). | `smtp` |
| `SMTP_HOST` | Required (smtp) | — | SMTP server hostname. | `smtp.sendgrid.net` |
| `SMTP_PORT` | Optional | `587` | SMTP server port. | `465` |
| `SMTP_USERNAME` | Required (smtp) | — | SMTP authentication username. | `apikey` |
| `SMTP_PASSWORD` | Required (smtp) | — | SMTP authentication password. | `SG.xxxxx` |
| `EMAIL_FROM` | Optional | `noreply@agenthifive.com` | Sender address for outbound emails. For ACS, defaults to `DoNotReply@agenthifive.com`. | `noreply@example.com` |
| `ACS_CONNECTION_STRING` | Required (acs) | — | Azure Communication Services connection string for the ACS email provider. | `endpoint=https://...;accesskey=...` |

## External Services

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `SENTRY_DSN` | Optional | — | Sentry Data Source Name for error monitoring. When unset, Sentry is disabled. | `https://abc@o123.ingest.sentry.io/456` |
| `SENTRY_ENVIRONMENT` | Optional | `development` | Sentry environment tag. | `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | Optional | `1.0` (dev) | Fraction of transactions sent to Sentry for performance tracing (0.0 to 1.0). | `0.2` |
| `SENTRY_SERVER_NAME` | Optional | — | Server name tag reported to Sentry. | `api-prod-01` |
| `TELEGRAM_BOT_TOKEN` | Optional | — | Telegram Bot API token for the Telegram connection provider and notification channel. | `123456:ABC-DEF...` |
| `EXPO_ACCESS_TOKEN` | Optional | — | Expo push notification access token for mobile push notifications. | `ExponentPushToken[...]` |

## Security

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `BASIC_AUTH_PASSWORD` | Optional | — | When set, enables a Basic Auth gate on all non-health, non-auth endpoints. Username is always `ah5`. Useful for staging/preview environments. | `my-staging-password` |
| `AZURE_FRONT_DOOR_ID` | Optional | — | Azure Front Door profile `resource_guid`. When set, requests without a matching `X-Azure-FDID` header are rejected with 403. | `12345678-abcd-...` |
| `TURNSTILE_SECRET_KEY` | Optional | — | Cloudflare Turnstile secret key for bot protection on registration. When unset, Turnstile verification is skipped. | `0x4AAA...` |
| `SSRF_ALLOWLIST_HOSTS` | Optional | — | Comma-separated hostnames that bypass private-IP SSRF checks. Used for integration testing with Docker internal hostnames. **Never set in production.** | `echo,mock-provider` |

## Enterprise

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `ADMIN_EMAIL` | Optional | — | Email address for the auto-seeded superadmin user (enterprise overlay). Both `ADMIN_EMAIL` and `ADMIN_PASSWORD` must be set to seed. | `admin@example.com` |
| `ADMIN_PASSWORD` | Optional | — | Password for the auto-seeded superadmin user (enterprise overlay). | `StrongP@ss!` |

## Frontend Feature Flags (NEXT_PUBLIC_*)

These are build-time flags that control UI feature visibility. They are automatically derived from OAuth provider variables in `next.config.mjs` but can be set explicitly to override.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `NEXT_PUBLIC_SOCIAL_GOOGLE` | Optional | Derived from `AUTH_GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_ID` | Show Google sign-in button when truthy. | `1` |
| `NEXT_PUBLIC_SOCIAL_MICROSOFT` | Optional | Derived from `AUTH_MICROSOFT_CLIENT_ID` or `MICROSOFT_CLIENT_ID` | Show Microsoft sign-in button when truthy. | `1` |
| `NEXT_PUBLIC_SOCIAL_APPLE` | Optional | Derived from `APPLE_CLIENT_ID` | Show Apple sign-in button when truthy. | `1` |
| `NEXT_PUBLIC_SOCIAL_FACEBOOK` | Optional | Derived from `FACEBOOK_CLIENT_ID` | Show Facebook sign-in button when truthy. | `1` |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Optional | — | Cloudflare Turnstile site key for the registration page captcha widget. | `0x4BBB...` |
| `NEXT_PUBLIC_BUILD_NUMBER` | Optional | — | Build number displayed on the Settings page. Typically set by CI. | `142` |
| `NEXT_PUBLIC_BUILD_DATE` | Optional | — | Build date displayed on the Settings page. Typically set by CI. | `2026-04-04` |

## Build / CI Metadata

These are typically injected by the CI/CD pipeline and exposed via `GET /v1/version`.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `BUILD_NUMBER` | Optional | `dev` | Build number returned by the version endpoint. | `142` |
| `BUILD_DATE` | Optional | `unknown` | Build date returned by the version endpoint. | `2026-04-04T12:00:00Z` |
| `GIT_SHA` | Optional | `unknown` | Git commit SHA returned by the version endpoint and reported to Sentry as the release. | `a1b2c3d` |

## Production Docker Compose

These variables are used by the production Docker Compose file and Nginx configuration, not by the application directly.

| Variable | Required | Default | Description | Example |
|---|---|---|---|---|
| `NGINX_HOST` | **Required** | — | Production domain used for TLS certificate generation and Nginx `server_name`. | `app.example.com` |
| `POSTGRES_USER` | **Required** | — | PostgreSQL container user. Must match the user in `DATABASE_URL`. | `agenthifive` |
| `POSTGRES_PASSWORD` | **Required** | — | PostgreSQL container password. Must match the password in `DATABASE_URL`. | `StrongP@ss!` |
| `POSTGRES_DB` | **Required** | — | PostgreSQL container database name. Must match the database in `DATABASE_URL`. | `agenthifive` |
