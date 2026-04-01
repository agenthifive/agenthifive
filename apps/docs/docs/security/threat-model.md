---
title: Threat Model
sidebar_position: 3
sidebar_label: Threat Model
description: Threat analysis, attack vectors, and mitigations for the AgentHiFive authority delegation platform.
---

# Threat Model

AgentHiFive sits between AI agents and third-party provider APIs. This position makes it a high-value target. This page documents the threat analysis, attack vectors, and mitigations built into the platform.

## Trust Boundaries

```
Agent (untrusted) --> AgentHiFive API --> Provider API (Google, Microsoft, Telegram)
                          |
                     Policy Engine
                     Token Vault (encrypted at rest)
                     Audit Log (append-only)
```

| Boundary | Trust Level | What Crosses It |
|----------|-------------|-----------------|
| Agent to API | Untrusted | API key, execution requests |
| API to Provider | Trusted (scoped) | OAuth access tokens, HTTP requests |
| User to Web Dashboard | Authenticated | Session JWT, policy configuration |
| API to Database | Trusted | Drizzle ORM queries (parameterized) |
| API to KMS/Vault | Trusted | DEK encrypt/decrypt operations |

## Attack Vectors and Mitigations

### 1. Stolen Agent API Key

**Threat:** An attacker obtains an agent's API key and makes unauthorized requests to provider APIs.

**Mitigations:**
- Policies restrict what each agent can do: allowlists limit URLs and HTTP methods, rate limits cap request volume, time windows restrict when access is allowed.
- Step-up approval can require human confirmation for sensitive operations.
- Every request is audit-logged with the agent identity, enabling rapid detection.
- API keys can be revoked immediately via the dashboard.

### 2. Token Vault Compromise

**Threat:** An attacker gains access to the database and reads encrypted provider tokens.

**Mitigations:**
- Tokens are encrypted with AES-256-GCM using envelope encryption. The Data Encryption Keys (DEKs) are themselves encrypted by a Key Encryption Key (KEK) in KMS/Vault.
- Without access to the KEK (which never leaves the HSM boundary), the encrypted tokens are useless.
- Database access is restricted to the API service via network policies and connection credentials.
- Key rotation limits the window of exposure.

### 3. Server-Side Request Forgery (SSRF)

**Threat:** A malicious agent crafts an execution request targeting internal infrastructure (e.g., `http://169.254.169.254/` for cloud metadata).

**Mitigations:**
- The `ssrf-protection` utility validates all target URLs before proxying. It blocks loopback addresses (127.0.0.0/8, ::1), RFC 1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local addresses (169.254.0.0/16, fe80::/10), and other special-use ranges.
- DNS resolution is checked to prevent DNS rebinding attacks where a hostname resolves to a private IP.
- URL canonicalization prevents path traversal and Unicode normalization attacks.

### 4. JWT Forgery or Replay

**Threat:** An attacker forges a JWT or replays an expired token to gain unauthorized access.

**Mitigations:**
- JWTs are signed with RS256 and verified against a JWKS endpoint. The private key never leaves the web service.
- JWTs have a 5-minute TTL, limiting the replay window.
- Required claims (`sub`, `wid`, `roles`, `scp`, `sid`) are validated on every request. Missing or malformed claims result in rejection.
- The `jwt-auth` plugin validates token structure, signature, expiration, and claim types before any route handler executes.

### 5. Policy Bypass

**Threat:** An agent constructs a request that circumvents policy restrictions (e.g., URL pattern matching, rate limit evasion).

**Mitigations:**
- Allowlist matching uses strict URL pattern comparison with HTTPS enforcement. HTTP URLs are rejected.
- Rate limits are enforced per-agent, per-connection with configurable time windows.
- Default policy mode is `deny` -- only explicitly allowed operations proceed.
- Policy evaluation is logged in the audit trail, including the decision rationale.

### 6. OAuth Token Theft via Callback Manipulation

**Threat:** An attacker manipulates the OAuth callback URL to intercept authorization codes.

**Mitigations:**
- OAuth flows use PKCE (Proof Key for Code Exchange) with S256 challenge method. The code verifier is stored server-side and never exposed to the client.
- Callback URLs are validated against a pre-registered allowlist.
- Pending connection records track the expected `state` parameter and expire after a short window.

### 7. Privilege Escalation via Workspace Isolation Failure

**Threat:** An agent or user accesses resources belonging to a different workspace.

**Mitigations:**
- Every database query is scoped by `workspace_id` extracted from the authenticated JWT.
- The API never accepts `workspace_id` as a request parameter -- it is always derived from the token.
- Test suite includes explicit workspace isolation tests for every route.

### 8. Audit Log Tampering

**Threat:** An attacker modifies or deletes audit log entries to cover their tracks.

**Mitigations:**
- Audit events are stored in an append-only log table (`l_audit_events`). Normal application operations never update or delete audit records.
- Audit logging is asynchronous to avoid blocking the response path, but the audit event is created before the response is sent.
- Each audit entry includes the actor identity, timestamp, action, decision, and request metadata.

### 9. Denial of Service via Rate Limit Exhaustion

**Threat:** An attacker exhausts an agent's rate limit to prevent legitimate operations.

**Mitigations:**
- Rate limits are per-agent, per-connection. Exhausting one agent's limit does not affect other agents.
- The API returns `429 Too Many Requests` with a `Retry-After` header, enabling well-behaved clients to back off.
- Dashboard visibility into rate limit status enables workspace administrators to detect and respond to abuse.

### 10. Supply Chain Attacks

**Threat:** A compromised dependency introduces malicious code into the platform.

**Mitigations:**
- Dependencies are pinned via `pnpm-lock.yaml` with `--frozen-lockfile` in CI.
- The SDK and core packages have minimal external dependencies (the SDK uses only the built-in `fetch` API).
- Docker images use multi-stage builds to minimize the attack surface of production containers.

## Security Checklist

:::tip For Deployers
Review this checklist before deploying AgentHiFive to production.
:::

- [ ] KMS/Vault is configured for token encryption (not hardcoded keys).
- [ ] Secrets are stored in a managed secrets service (not `.env` files).
- [ ] Database access is restricted to the API service via network policy.
- [ ] JWT signing keys are rotated on a 90-day schedule.
- [ ] Audit log retention policy is configured.
- [ ] Emergency key rotation procedure is documented and tested.
- [ ] SSRF protection is enabled (default).
- [ ] OAuth callback URLs are restricted to known domains.
