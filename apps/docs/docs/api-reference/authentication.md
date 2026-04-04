---
title: Authentication
sidebar_position: 2
sidebar_label: Authentication
description: How to authenticate with the AgentHiFive API using JWTs, Personal Access Tokens, or Agent Access Tokens.
---

# Authentication

AgentHiFive supports three authentication methods:

| Method | Audience | Lifetime | Header |
|---|---|---|---|
| **Bearer JWT** | Browser / dashboard | 5 minutes | `Authorization: Bearer eyJ...` |
| **Personal Access Token (PAT)** | CI/CD, scripts | 1-90 days | `X-API-Key: ah5p_...` |
| **Agent Access Token** | AI agents | 2 hours (default) | `Authorization: Bearer ah5t_...` |

## Bearer JWT (Session-Based)

The primary authentication flow exchanges a Better Auth session cookie for a short-lived JWT that the API server accepts.

### Token Exchange Flow

```
POST /api/auth/token
```

This endpoint lives on the **Fastify API server**. It reads the session cookie, validates the session, and returns a signed JWT.

**Request**: No body required. The session cookie is sent automatically by the browser.

**Response**:

```json
{
  "token": "eyJhbGciOiJSUzI1NiIs...",
  "expiresAt": "2025-06-01T00:05:00Z"
}
```

| Field | Type | Description |
|---|---|---|
| `token` | `string` | Signed JWT for API access |
| `expiresAt` | `string` | ISO 8601 expiration timestamp (5 minutes from issuance) |

### JWT Claims

The issued JWT contains the following claims:

```typescript
interface ApiAccessClaims {
  iss: string;    // Issuer: "https://app.agenthifive.com"
  aud: "api";     // Audience: always "api"
  sub: string;    // Subject: user ID
  sid: string;    // Session ID
  wid: string;    // Workspace ID
  roles: string[];  // Workspace roles (e.g., ["owner", "admin"])
  scp: string[];    // Scopes (e.g., ["api:read", "api:write"])
  iat: number;    // Issued at (epoch seconds)
  exp: number;    // Expiration (epoch seconds)
  jti: string;    // Unique JWT ID
}
```

### JWKS Endpoint

The API server verifies JWTs using the public key served from itself:

```
GET /.well-known/jwks.json
```

This endpoint is hosted on the **Fastify API server**. The API server fetches and caches this key set using `jose`'s `createRemoteJWKSet`.

### Example: Using a Bearer JWT

```bash
# 1. Exchange session for JWT (browser sends cookie automatically)
TOKEN=$(curl -s -b cookies.txt http://localhost:3000/api/auth/token | jq -r '.token')

# 2. Call the API with the JWT
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8080/v1/connections
```

## Personal Access Tokens (PATs)

PATs provide long-lived API access without a browser session. They are useful for CI/CD pipelines, scripts, and agent frameworks.

### Creating a PAT

```
POST /v1/tokens
```

**Request body**:

```json
{
  "name": "CI/CD Pipeline",
  "expiresInDays": 30
}
```

**Response** (the `plainToken` value is shown **only once** on creation):

```json
{
  "token": {
    "id": "uuid",
    "name": "CI/CD Pipeline",
    "expiresAt": "2025-07-01T00:00:00Z",
    "createdAt": "2025-06-01T00:00:00Z",
    "isExpired": false
  },
  "plainToken": "ah5p_aBcDeFgHiJkLmNoPqRsTuVwXyZ..."
}
```

### Using a PAT

Pass the token in the `X-API-Key` header:

```bash
curl -H "X-API-Key: ah5p_aBcDeFgHiJkLmNoPqRsTuVwXyZ..." \
     http://localhost:8080/v1/connections
```

### PAT Management

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/v1/tokens` | Create a new PAT |
| `GET` | `/v1/tokens` | List all active (non-revoked) PATs |
| `PUT` | `/v1/tokens/:id` | Rename a PAT |
| `DELETE` | `/v1/tokens/:id` | Revoke a PAT (takes effect immediately) |

PAT tokens use the prefix `ah5p_` and have a configurable lifetime of 1-90 days (default: 30 days). Only the SHA-256 hash of the token is stored server-side.

## Agent Access Tokens

Agent access tokens provide short-lived, cryptographically-bound authentication for AI agents. Unlike PATs (which are long-lived shared secrets), agent tokens use the `private_key_jwt` pattern where the agent holds an ES256 private key and exchanges signed assertions for opaque access tokens.

### How It Works

1. Create an agent in the dashboard → receive a one-time bootstrap secret (`ah5b_`)
2. Agent generates an ES256 key pair and bootstraps via `POST /v1/agents/bootstrap`
3. Agent signs a JWT assertion with its private key and exchanges it at `POST /v1/agents/token`
4. Agent uses the returned `ah5t_` access token as `Authorization: Bearer ah5t_...`

### Using an Agent Access Token

```bash
curl -H "Authorization: Bearer ah5t_aBcDeFgHiJkLmNoPqRsTuVwXyZ..." \
     http://localhost:4000/v1/vault/execute \
     -d '{"model": "B", "connectionId": "...", "method": "GET", "url": "..."}'
```

Access tokens default to 2 hours TTL (configurable via `AGENT_TOKEN_TTL_SECONDS`). The private key never leaves the agent machine.

See [Agent Authentication](./agent-auth.md) for the full bootstrap and token exchange API reference.

## Authentication Errors

| Status | Description |
|---|---|
| `401` | Missing or invalid token / API key / agent access token |
| `403` | Valid token but insufficient permissions |
