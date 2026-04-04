---
title: Endpoint Contracts
sidebar_position: 4
sidebar_label: Endpoint Contracts
description: TypeScript types, Zod schemas, and auth flow contracts for the AgentHiFive API.
---

# Endpoint Contracts

All cross-service requests and responses are defined as Zod schemas in `packages/contracts`. This page covers the core entity types, the auth flow, and the OAuth connector interface.

## Common Types

Branded types provide compile-time safety for IDs that are all strings at runtime:

```typescript title="packages/contracts/src/common.ts"
import { z } from "zod";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type AgentId = Brand<string, "AgentId">;
export type PolicyId = Brand<string, "PolicyId">;
export type AuditId = Brand<string, "AuditId">;

export const WorkspaceRoleSchema = z.enum([
  "owner", "admin", "member", "viewer", "agent"
]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const PlatformRoleSchema = z.enum(["user", "superadmin"]);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;

export const ScopeSchema = z.string().min(1);
export type Scope = z.infer<typeof ScopeSchema>;
```

## JWT Claims

The internal API JWT carries these claims. Issued by `apps/web`, verified by `apps/api`:

```typescript title="packages/contracts/src/auth.ts"
export const ApiAccessClaimsSchema = z.object({
  iss: z.string().min(1),           // Issuer: "https://app.agenthifive.com"
  aud: z.literal("api"),             // Audience: always "api"
  sub: z.string().min(1),           // Subject: UserId
  sid: z.string().min(1),           // Session ID
  wid: z.string().min(1),           // Workspace ID
  roles: z.array(WorkspaceRoleSchema),
  scp: z.array(ScopeSchema),        // e.g., ["api:read", "api:write"]
  iat: z.number().int(),            // Issued at (epoch seconds)
  exp: z.number().int(),            // Expiration (epoch seconds)
  jti: z.string().min(1),          // Unique token ID
});
export type ApiAccessClaims = z.infer<typeof ApiAccessClaimsSchema>;
```

## Token Exchange

The web app converts a Better Auth session cookie into a short-lived JWT for API access.

**Endpoint:** `POST /api/internal/token/exchange`

```typescript title="packages/contracts/src/auth.ts"
export const TokenExchangeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  requestedScopes: z.array(ScopeSchema).default([]),
});

export const TokenExchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),  // Seconds (e.g., 300)
});
```

### Token Issuance Example

```typescript
import { SignJWT } from "jose";

const jwt = await new SignJWT({
  iss: "https://app.agenthifive.com",
  aud: "api",
  sub: principal.userId,
  sid: principal.sessionId,
  wid: principal.workspaceId,
  roles: principal.roles,
  scp: principal.defaultScopes,
})
  .setProtectedHeader({ alg: "RS256", kid: "web-2024-01" })
  .setIssuedAt()
  .setExpirationTime("5m")
  .setJti(crypto.randomUUID())
  .sign(privateKey);
```

### Token Verification Example

```typescript
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://app.agenthifive.com/.well-known/jwks.json")
);

const { payload } = await jwtVerify(token, JWKS, {
  issuer: "https://app.agenthifive.com",
  audience: "api",
});

const claims = ApiAccessClaimsSchema.parse(payload);
```

## Fastify Auth Plugin

The API uses a global `preHandler` hook for JWT verification and per-route scope guards:

```typescript title="apps/api/src/plugins/auth-jwt/types.ts"
interface RequestAuthContext {
  userId: UserId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  roles: WorkspaceRole[];
  scopes: Scope[];
  tokenId: string;  // jti claim
}

// Attached to every authenticated request
declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuthContext;
  }
}
```

Per-route scope enforcement:

```typescript
{
  preHandler: requireScope("integrations:write")
}
```

## Security Contracts

### JWT Interfaces

```typescript title="packages/security/src/jwt.ts"
interface JwtIssuer {
  issueApiAccessToken(input: IssueApiTokenInput): Promise<string>;
}

interface JwtVerifier {
  verifyApiAccessToken(token: string): Promise<ApiAccessClaims>;
}
```

### Encryption Envelope

Provider tokens are encrypted at rest using AES-256-GCM envelope encryption:

```typescript title="packages/security/src/crypto.ts"
interface EncryptedEnvelopeV1 {
  v: 1;                // Version
  kid: string;         // Key ID for rotation
  alg: "A256GCM";      // Algorithm
  iv: string;          // Initialization vector (base64url)
  ciphertext: string;  // Encrypted data (base64url)
  tag: string;         // Authentication tag (base64url)
  aad?: string;        // Additional authenticated data (base64url)
}
```

## OAuth Contracts

```typescript title="packages/contracts/src/oauth.ts"
export const OAuthProviderSchema = z.enum([
  "google", "microsoft", "telegram", "github", "slack",
  "anthropic", "openai", "gemini", "openrouter",
  "notion", "trello", "jira",
]);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const OAuthTokenSetSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string().default("Bearer"),
  expiresAt: z.number().int().optional(),
  scope: z.array(ScopeSchema).optional(),
});
```

### OAuth Connector Interface

```typescript title="packages/oauth-connectors/src/types.ts"
interface OAuthConnector {
  capabilities(): ProviderCapabilities;
  createAuthorizationUrl(input: AuthCodeStartInput): Promise<AuthCodeStartOutput>;
  exchangeAuthorizationCode(input: AuthCodeExchangeInput): Promise<OAuthTokenSet>;
  refresh(provider: OAuthProvider, refreshToken: string): Promise<OAuthTokenSet>;
  revoke?(provider: OAuthProvider, token: string, hint?: "access_token" | "refresh_token"): Promise<void>;
}
```

### Provider Capabilities

| Provider | Auth Code | PKCE | Notes |
|----------|-----------|------|-------|
| Google | Yes | Yes | Full OAuth 2.0 + OIDC |
| Microsoft | Yes | Yes | Azure AD v2.0 |
| Telegram | No | No | Bot API token, not OAuth |
| GitHub | Yes | Yes | OAuth Apps or GitHub Apps |
| Slack | Yes | Yes | Slack OAuth v2 |
| Anthropic | No | No | API key based |
| OpenAI | No | No | API key based |
| Gemini | No | No | API key based |
| OpenRouter | No | No | API key based |
| Notion | Yes | No | OAuth 2.0 |
| Trello | Yes | No | OAuth 1.0a |
| Jira | Yes | Yes | Atlassian OAuth 2.0 (3LO) |
