---
title: Agent Authentication
sidebar_position: 7
sidebar_label: Agent Authentication
description: Agent onboarding endpoints -- bootstrap (register/rotate public key) and token exchange via ES256 client assertions.
---

# Agent Authentication

These endpoints handle agent onboarding and token exchange using the `private_key_jwt` pattern ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)). Both endpoints are **unauthenticated** (no Bearer token or API key required) and have per-IP rate limits.

## Overview

The agent authentication flow replaces static API keys with asymmetric key-based auth:

1. **Dashboard** creates an agent → returns a one-time bootstrap secret (`ah5b_` prefix)
2. **Agent** generates an ES256 key pair locally and calls `/v1/agents/bootstrap` with the secret + public key
3. **Agent** signs a short-lived JWT (client assertion) with its private key and exchanges it at `/v1/agents/token` for a short-lived opaque access token (`ah5t_` prefix)
4. **Agent** uses the access token as `Authorization: Bearer ah5t_...` for all Vault API calls

The private key never leaves the agent machine. Access tokens default to 2 hours and can be refreshed by signing a new assertion.

## Endpoint Summary

| Method | Endpoint | Rate Limit | Description |
|---|---|---|---|
| `POST` | `/v1/agents/bootstrap` | 5/min/IP | Register or rotate an agent's public key using a bootstrap secret |
| `POST` | `/v1/agents/token` | 30/min/IP | Exchange a signed client assertion for an access token |

---

## Bootstrap {#bootstrap}

```
POST /v1/agents/bootstrap
```

Registers or rotates the agent's ES256 public key using a one-time bootstrap secret. Works for both first enrollment (`created` → `active`) and key rotation (`active` → replace key + invalidate tokens).

**Request**:

```json
{
  "bootstrapSecret": "ah5b_aBcDeFgHiJkLmNoPqRsTuVwXyZ...",
  "publicKey": {
    "kty": "EC",
    "crv": "P-256",
    "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `bootstrapSecret` | Yes | One-time secret from agent creation or bootstrap-secret endpoint (`ah5b_` prefix) |
| `publicKey` | Yes | ES256 (P-256) public key in JWK format. Must include `kty`, `crv`, `x`, `y`. |

**Behavior by agent status**:

| Agent Status | Action |
|---|---|
| `created` | Activates the agent, registers the public key, sets `enrolledAt` |
| `active` | Replaces the public key, **invalidates all existing access tokens** |
| `disabled` | Rejected with `409` |

**Response** (`200`):

```json
{
  "agentId": "uuid",
  "name": "Email Assistant",
  "status": "active",
  "workspaceId": "uuid"
}
```

**Errors**:

| Status | Reason |
|---|---|
| `400` | Invalid public key (not ES256/P-256), missing fields |
| `401` | Invalid, expired, or already-consumed bootstrap secret |
| `409` | Agent is disabled |

---

## Token Exchange {#token}

```
POST /v1/agents/token
```

Exchanges a signed ES256 client assertion JWT for a short-lived opaque access token. Supports both JSON and `application/x-www-form-urlencoded` request bodies.

**Request (JSON)**:

```json
{
  "grant_type": "client_assertion",
  "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
  "client_assertion": "eyJhbGciOiJFUzI1NiIs..."
}
```

**Request (form-urlencoded)**:

```
grant_type=client_assertion&client_assertion_type=urn%3Aietf%3Aparams%3Aoauth%3Aclient-assertion-type%3Ajwt-bearer&client_assertion=eyJhbGciOiJFUzI1NiIs...
```

| Field | Required | Description |
|---|---|---|
| `grant_type` | Yes | Must be `"client_assertion"` |
| `client_assertion_type` | Yes | Must be `"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"` |
| `client_assertion` | Yes | Signed ES256 JWT (see below) |

### Client Assertion JWT

The client assertion is a JWT signed with the agent's ES256 private key:

**Header**:

```json
{
  "alg": "ES256",
  "typ": "JWT"
}
```

**Payload**:

```json
{
  "iss": "<agent-id>",
  "sub": "<agent-id>",
  "aud": "<token-audience>",
  "iat": 1700000000,
  "exp": 1700000060,
  "jti": "unique-random-id"
}
```

| Claim | Required | Description |
|---|---|---|
| `iss` | Yes | Agent ID (must match `sub`) |
| `sub` | Yes | Agent ID |
| `aud` | Yes | Token audience. Defaults to the API base URL. Configurable via `AGENT_TOKEN_AUDIENCE` env var. |
| `iat` | Yes | Issued-at timestamp (epoch seconds) |
| `exp` | Yes | Expiration timestamp. Must be at most 60 seconds after `iat`. |
| `jti` | Yes | Unique identifier. Each `jti` can only be used once (replay protection). |

**Response** (`200`):

```json
{
  "access_token": "ah5t_aBcDeFgHiJkLmNoPqRsTuVwXyZ...",
  "token_type": "Bearer",
  "expires_in": 7200
}
```

The access token is opaque (not a JWT). Use it as `Authorization: Bearer ah5t_...` for all authenticated API calls (Vault, connections, etc.).

**Errors**:

| Status | Reason |
|---|---|
| `401` | Invalid signature, expired assertion, wrong algorithm, wrong audience, replayed `jti`, agent not active |

---

## Complete Example

Here is the full flow using the `jose` library in Node.js:

```typescript
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { randomUUID } from "node:crypto";

// 1. Generate an ES256 key pair (do this once, persist the private key)
const { publicKey, privateKey } = await generateKeyPair("ES256");
const publicJwk = await exportJWK(publicKey);

// 2. Bootstrap the agent
const bootstrapRes = await fetch("http://localhost:4000/v1/agents/bootstrap", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    bootstrapSecret: "ah5b_...",
    publicKey: publicJwk,
  }),
});
const { agentId } = await bootstrapRes.json();

// 3. Sign a client assertion
const assertion = await new SignJWT({ jti: randomUUID() })
  .setProtectedHeader({ alg: "ES256" })
  .setIssuer(agentId)
  .setSubject(agentId)
  .setAudience("http://localhost:4000")
  .setIssuedAt()
  .setExpirationTime("30s")
  .sign(privateKey);

// 4. Exchange for an access token
const tokenRes = await fetch("http://localhost:4000/v1/agents/token", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "client_assertion",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  }),
});
const { access_token } = await tokenRes.json();

// 5. Use the access token to call the Vault
const vaultRes = await fetch("http://localhost:4000/v1/vault/execute", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${access_token}`,
  },
  body: JSON.stringify({
    model: "B",
    connectionId: "your-connection-id",
    method: "GET",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  }),
});
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AGENT_TOKEN_TTL_SECONDS` | `7200` (2 hours) | Access token lifetime |
| `AGENT_TOKEN_AUDIENCE` | API base URL | Expected `aud` claim in client assertions |
| `BOOTSTRAP_SECRET_TTL_HOURS` | `1` | Bootstrap secret expiry |

## Security Properties

- **No shared secrets**: The private key never leaves the agent machine. Only the public key is stored server-side.
- **Short-lived tokens**: Access tokens expire in 2 hours by default. Compromise window is minimal.
- **Replay protection**: Each client assertion `jti` can only be used once. The jti is stored in PostgreSQL (`l_jti_replay_cache` table) with a primary key constraint for atomic cross-replica detection.
- **Instant revocation**: Disabling an agent immediately deletes all access tokens from the database.
- **Machine binding**: Only the machine holding the private key can sign valid assertions.
