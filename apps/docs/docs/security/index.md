---
title: Security
sidebar_position: 1
sidebar_label: Overview
description: Security architecture, authentication model, and key management overview for AgentHiFive.
---

# Security

AgentHiFive is an authority delegation platform -- security is not a feature, it is the product. This section documents the security architecture, encryption strategy, and threat model.

## Security Principles

1. **Zero trust for agents.** Every agent request is authenticated, authorized against a policy, and audit-logged. No implicit trust.
2. **Least privilege by default.** Policies default to deny. Agents only access what is explicitly allowed by allowlists, rate limits, and time windows.
3. **Envelope encryption for secrets.** Provider tokens are encrypted at rest using AES-256-GCM with envelope encryption. Key Encryption Keys (KEKs) never leave the KMS boundary.
4. **Audit everything.** Every execution, approval, connection change, and policy modification is recorded in an append-only audit log.
5. **Algorithm agility.** Encryption envelopes and JWT signatures include algorithm identifiers and version numbers, enabling migration to post-quantum algorithms without re-architecture.

## Authentication Model

AgentHiFive uses a layered authentication model:

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **User auth** | Better Auth (passkeys, OAuth) | Human users accessing the web dashboard. |
| **Session tokens** | JWTs signed with RS256 via JWKS | Stateless session validation across services. JWTs have a 5-minute TTL. |
| **Agent auth** | API keys (`ah5_...` prefix) | AI agents calling the execution gateway. Scoped to a workspace. |
| **Provider auth** | OAuth 2.0 access/refresh tokens | Delegated access to third-party provider APIs (Google, Microsoft, Telegram). |

:::info JWT Verification
The API service verifies JWTs by fetching the public key set (JWKS) from the web service. Keys are cached and rotated on a 90-day schedule. Multiple key IDs (`kid`) are supported simultaneously during rotation.
:::

## Key Management Overview

AgentHiFive requires two distinct security systems:

### Secrets Management

Application secrets (OAuth client credentials, database passwords, API keys) are stored outside the codebase:

| Environment | Solution |
|-------------|----------|
| Development | `.env` files (local only) |
| SaaS Production | AWS Secrets Manager or Azure Key Vault |
| Self-Hosted Production | HashiCorp Vault or SOPS |
| Self-Hosted (Simple) | Kubernetes Secrets or Docker Secrets |

### Encryption Key Management

Provider tokens are encrypted at rest using envelope encryption:

| Environment | KEK Provider | Key Rotation |
|-------------|-------------|--------------|
| SaaS Production | AWS KMS | Automatic (annual) |
| Self-Hosted Production | Vault Transit | Versioned (zero-downtime) |
| Self-Hosted (Simple) | age encryption | Manual |
| Development | Hardcoded key | N/A |

:::danger Production Rule
Never use `.env` files or hardcoded keys in production (SaaS or self-hosted).
:::

## Key Rotation Schedule

| Asset | Frequency | Method |
|-------|-----------|--------|
| KEK (master key) | Every 365 days | KMS auto / Vault rotate / age manual |
| DEK (workspace key) | Every 90 days | Re-generate and re-encrypt tokens |
| JWT signing keys | Every 90 days | New `kid`, keep old for verification |
| OAuth provider tokens | On refresh | Standard OAuth refresh flow |
| Emergency rotation | Immediate | Force rotate + rewrap all tokens |

## Next Steps

- [Encryption](./encryption.md) -- AES-256-GCM envelope encryption and key provider details.
- [Threat Model](./threat-model.md) -- threat analysis, attack vectors, and mitigations.
