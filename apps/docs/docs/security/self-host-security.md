---
title: Self-Host Security
sidebar_position: 4
sidebar_label: Self-Host Security
description: Security hardening guide for self-hosted AgentHiFive deployments — encryption, networking, secrets, and monitoring.
---

# Self-Host Security Guide

This guide covers the security measures you should apply when running AgentHiFive on your own infrastructure. It is written as a practical reference for operators, with commands you can run directly and a checklist at the end.

---

## 1. Encryption Key Management

AgentHiFive encrypts all stored OAuth tokens, API keys, and bot tokens at rest using **AES-256-GCM**. The encryption implementation uses a random 96-bit initialization vector per operation and a 128-bit authentication tag, providing both confidentiality and integrity.

### Generating the key

```bash
openssl rand -hex 32
```

This produces a 64-character hex string representing 256 bits. Set it as the `ENCRYPTION_KEY` environment variable.

### How encryption works

The `@agenthifive/security` package handles all cryptographic operations. Every encrypted record is stored as an envelope containing:

- `v` -- envelope version (currently `1`), enabling future algorithm migration
- `alg` -- algorithm identifier (`A256GCM`)
- `iv` -- base64url-encoded initialization vector (96 bits, random per operation)
- `ciphertext` -- base64url-encoded encrypted data
- `tag` -- base64url-encoded GCM authentication tag (128 bits)

The key is validated at encryption and decryption time -- it must be exactly 32 bytes (256 bits). An incorrect key length will cause an immediate error, not silent corruption.

### Key rotation

1. Generate a new key: `openssl rand -hex 32`
2. Update the `ENCRYPTION_KEY` environment variable
3. Restart the API service

A background job automatically re-encrypts existing records with the new key. During re-encryption, records encrypted with the old key are still decryptable because the envelope format supports version tracking.

### Key initialization modes

The API supports two key initialization modes, configured via `ENCRYPTION_KEY_MODE`:

| Mode | Use case | How it works |
|------|----------|--------------|
| `env` (default) | Dev, test, simple deployments | Reads `ENCRYPTION_KEY` from environment variables |
| `azure-kv` | Azure production | Unwraps a Data Encryption Key from Azure Key Vault at startup using Managed Identity |

For Azure Key Vault mode, set these additional variables:
- `AZURE_KEY_VAULT_URI` -- your Key Vault URI (e.g., `https://kv-prod-ah5.vault.azure.net`)
- `AZURE_KV_KEK_NAME` -- name of the Key Encryption Key (default: `data-encryption-kek`)
- `AZURE_KV_WRAPPED_DEK_SECRET` -- secret name for the wrapped DEK (default: `WRAPPED-DATA-KEY`)
- `AZURE_MANAGED_IDENTITY_CLIENT_ID` -- optional, for user-assigned identity

### Backup strategy

Store the encryption key in a secure vault or encrypted file **outside** the deployment. If the key is lost, all encrypted tokens become unrecoverable.

### Enterprise key management

For production deployments with strict compliance requirements, use envelope encryption with a managed Key Encryption Key (KEK):

- **Azure Key Vault** -- use `azure-kv` mode (built-in support)
- **AWS KMS** -- wrap/unwrap DEKs using `GenerateDataKey` and `Decrypt` APIs
- **HashiCorp Vault Transit** -- encryption-as-a-service with versioned keys and zero-downtime rotation

See the [Security & Secrets Architecture](/security/encryption) docs for detailed patterns for each provider.

---

## 2. Authentication Secrets

### BETTER_AUTH_SECRET

Signs session cookies for the dashboard UI. Generate it:

```bash
openssl rand -hex 32
```

Rotating this value invalidates all active user sessions immediately. Users will need to sign in again.

### JWT_PRIVATE_KEY

RS256 private key for signing agent JWTs. Generate a 2048-bit RSA key:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -outform PEM
```

Store the PEM output as the `JWT_PRIVATE_KEY` environment variable. In development, the API auto-generates an ephemeral key pair if this is not set.

### JWT_KID

The key ID published in the JWKS endpoint. Set it to any unique string (a UUID works well):

```bash
uuidgen
```

When rotating JWT signing keys, change the `JWT_KID` so that verifiers can distinguish old keys from new ones.

### WEB_JWKS_URL

This **must** point to an internal address, not the public URL:

```
# Correct -- internal address
WEB_JWKS_URL=http://localhost:4000/.well-known/jwks.json

# Wrong -- public address (adds network round-trip, exposes to external manipulation)
WEB_JWKS_URL=https://app.example.com/.well-known/jwks.json
```

The API uses this URL to verify JWTs via `jose` and `createRemoteJWKSet`. Keeping it internal ensures the verification loop stays within the trusted network boundary.

---

## 3. Database Security

### Use strong credentials

The `.env.example` ships with `agenthifive:dev-password`. **Never use these in production.** Generate a strong password:

```bash
openssl rand -base64 24
```

### Enable TLS

Add `sslmode=require` (or `sslmode=verify-full` for CA-verified connections) to your connection string:

```
DATABASE_URL=postgresql://user:strongpassword@db.internal:5432/agenthifive?sslmode=require
```

### Restrict network access

The database should only be reachable from the API service. Configure your firewall or security group to block external access to port 5432. In Docker Compose, do not publish the database port to the host.

### Regular backups

Use `pg_dump` on a schedule, or enable your managed database provider's automated backups:

```bash
pg_dump "$DATABASE_URL" --format=custom --file=backup-$(date +%Y%m%d).dump
```

### Protect the audit log

The `l_audit_events` table is append-only by design. The database user for the API should have `INSERT` and `SELECT` privileges on this table, but **never** `DELETE` or `TRUNCATE`. This preserves the integrity of the audit trail.

---

## 4. Network Security

### Expose only HTTPS

Only port 443 should be reachable from the public internet. Block direct access to:

- PostgreSQL (5432)
- Fastify API (4000)
- Any internal services

### Built-in SSRF protection

All Model B (brokered proxy) outbound requests go through `checkHostSafety()`, which resolves the target hostname and blocks requests to:

- Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Loopback (127.0.0.0/8)
- Link-local (169.254.0.0/16)
- Carrier-grade NAT (100.64.0.0/10)
- Documentation/test ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
- Multicast and reserved ranges (224.0.0.0/4, 240.0.0.0/4)

This prevents agents from using the vault to probe your internal network.

### Allowing internal services

If the API needs to reach internal services (e.g., a self-hosted Notion or GitLab instance), set:

```
SSRF_ALLOW_PRIVATE=true
```

Use this with caution. Prefer an explicit allowlist of internal hostnames when possible.

---

## 5. Reverse Proxy & TLS

### Always terminate TLS at the reverse proxy

Do not expose the Fastify API directly to the internet. Use Nginx, Caddy, or a cloud load balancer to terminate TLS.

### Nginx configuration reference

The included template at `infra/nginx/prod.conf.template` provides a production-ready starting point. Key security settings from the template:

**TLS configuration:**

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
ssl_session_tickets off;
```

**Security headers:**

```nginx
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-XSS-Protection "1; mode=block" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
```

**HTTP to HTTPS redirect:**

```nginx
server {
    listen 80;
    server_name _;
    location / {
        return 301 https://$host$request_uri;
    }
}
```

### Sticky sessions

The Nginx template uses `hash $cookie_ah5sid consistent` for upstream routing. This is a **performance optimization** (keeps in-memory caches warm), not a correctness requirement. The system works correctly without sticky sessions.

### TLS certificates

Use Let's Encrypt with certbot for free, auto-renewing certificates. The Nginx template includes an ACME challenge location for certbot's HTTP-01 validation:

```nginx
location /.well-known/acme-challenge/ {
    root /var/www/certbot;
}
```

If your organization has its own CA, configure the certificate and key paths in the Nginx `ssl_certificate` and `ssl_certificate_key` directives.

---

## 6. OAuth Credential Security

### Store credentials securely

Google and Microsoft OAuth credentials (`CLIENT_ID` / `CLIENT_SECRET`) grant access to user accounts. They must be stored in a secrets manager in production:

- **Azure Key Vault** -- native support via Managed Identity
- **AWS Secrets Manager** -- automatic rotation, CloudTrail audit
- **HashiCorp Vault** -- self-hosted, open-source
- **Doppler** -- SaaS secrets management

### Never commit secrets

The `.env` file is gitignored by default. Verify this is the case in your deployment repository. Never commit OAuth credentials, encryption keys, or database passwords.

### Separate auth credentials from connection credentials

AgentHiFive uses two distinct sets of OAuth credentials:

| Variable prefix | Purpose | Used by |
|----------------|---------|---------|
| `AUTH_GOOGLE_*`, `AUTH_MICROSOFT_*` | User social login (dashboard sign-in) | Better Auth |
| `GOOGLE_*`, `MICROSOFT_*` | Agent OAuth connections (token vending) | Vault / OAuth connectors |

These should be separate OAuth applications in your provider console, with different redirect URIs and scopes.

### Redirect URI configuration

Register redirect URIs that exactly match your deployment URL. Mismatched URIs will cause OAuth flows to fail. For a deployment at `https://app.example.com`:

```
https://app.example.com/api/auth/callback/google
https://app.example.com/api/auth/callback/microsoft
```

---

## 7. Agent Authentication Hardening

### Token lifetimes

| Setting | Default | Description |
|---------|---------|-------------|
| `AGENT_TOKEN_TTL_SECONDS` | 7200 (2 hours) | Agent access token lifetime |
| `BOOTSTRAP_SECRET_TTL_HOURS` | 1 | Bootstrap secret expiry for initial agent registration |

For high-security environments, reduce `AGENT_TOKEN_TTL_SECONDS` to 900 (15 minutes) or less. Shorter tokens limit the blast radius of a compromised token.

### Built-in rate limits

- **Bootstrap endpoint**: 5 requests per minute per IP
- **Token exchange**: 30 requests per minute per IP

These limits are enforced at the Fastify layer and cannot be bypassed through the reverse proxy.

### JTI replay protection

Each agent JWT assertion includes a unique `jti` (JWT ID) claim. The API records used JTIs in the `l_jti_replay_cache` table with a PostgreSQL primary key constraint. If an assertion is replayed, the INSERT fails and the request is rejected. This works correctly across multiple API replicas without distributed coordination.

### Recommendations

- Use short token TTLs in production (15-60 minutes)
- Monitor the audit log for unusual agent authentication patterns
- Rotate bootstrap secrets after initial agent onboarding
- Use the policy engine to restrict each agent to the minimum required scopes and endpoints

---

## 8. Monitoring & Audit

### Audit log

All vault actions, policy evaluations, and administrative changes are logged to the `l_audit_events` table. This table is append-only and should never be truncated or have rows deleted.

### Exporting audit data

```bash
# CSV export
curl -H "Authorization: Bearer $TOKEN" \
  "https://app.example.com/v1/audit/export?format=csv" > audit.csv

# JSON export
curl -H "Authorization: Bearer $TOKEN" \
  "https://app.example.com/v1/audit/export?format=json" > audit.json
```

### Health monitoring

The API exposes a health endpoint:

```bash
curl https://app.example.com/health
```

Use this with your uptime monitoring tool (UptimeRobot, Pingdom, or a simple cron job with `curl`).

### Recommended alerts

Connect to your existing observability stack (Sentry, Datadog, Grafana, or similar) and set up alerts for:

- **Failed agent authentication attempts** -- may indicate credential compromise or misconfiguration
- **Rate limit hits** -- sustained rate limiting may indicate abuse or a misconfigured agent
- **Connection reauth failures** -- OAuth tokens that fail to refresh need operator attention
- **Health endpoint failures** -- service is down or unhealthy
- **Unusual vault execution patterns** -- spikes in Model B requests or requests to unexpected endpoints

### Sentry integration

AgentHiFive has built-in Sentry support. Set these environment variables to enable error tracking and performance tracing:

```
SENTRY_DSN=https://your-dsn@sentry.io/project-id
SENTRY_ENVIRONMENT=production
SENTRY_TRACES_SAMPLE_RATE=0.2
```

---

## 9. Deployment Checklist

Review each item before exposing your deployment to production traffic.

| Status | Item |
|--------|------|
| &#9744; | `ENCRYPTION_KEY` is a unique 64-character hex string (not the zeroed-out default from `.env.example`) |
| &#9744; | `BETTER_AUTH_SECRET` is a unique random string (not `dev-only-secret-change-in-production`) |
| &#9744; | `JWT_PRIVATE_KEY` is generated and not shared across environments |
| &#9744; | `DATABASE_URL` uses TLS (`sslmode=require`) and strong credentials |
| &#9744; | `WEB_JWKS_URL` points to an internal address (e.g., `http://localhost:4000/.well-known/jwks.json`) |
| &#9744; | TLS termination is configured at the reverse proxy |
| &#9744; | Security headers are enabled (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy) |
| &#9744; | Database port (5432) is not exposed publicly |
| &#9744; | OAuth redirect URIs match your deployment URL exactly |
| &#9744; | Audit log export is configured or accessible to administrators |
| &#9744; | Monitoring and alerting are configured for health and auth failures |
| &#9744; | `.env` file is not committed to version control |
| &#9744; | API bind host is set appropriately (`0.0.0.0` behind a reverse proxy, `127.0.0.1` if exposed directly) |
| &#9744; | Agent token TTLs are appropriate for your security posture |
