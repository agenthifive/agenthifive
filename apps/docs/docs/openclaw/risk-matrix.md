---
title: Risk Matrix
sidebar_position: 9
sidebar_label: "Risk Matrix"
description: "Risk assessment for every OpenClaw integration — channels, model providers, and plugins — including risk level, blast radius, rotation difficulty, and hardening recommendations."
---

# Risk Matrix

Every OpenClaw integration that handles credentials has been assessed for security risk. This matrix covers channels, model providers, and plugin packages, evaluating each on risk level, secret scope, rotation difficulty, blast radius, and recommended hardening measures.

---

## Risk Level Distribution

| Risk Level | Count | Description |
|---|---|---|
| **High** | 9 | Persistent sessions, user-delegated OAuth scopes, or local host access. Compromise has severe consequences. |
| **Medium-High** | 32 | Service/account API scope or plugin permissions. Broad access, moderate blast radius. |
| **Medium** | 12 | Provider/channel scoped access. Impact is limited to one integration. |
| **Low** | 1 | No cloud secret (local runtime only). |

---

## Channels

### High Risk

These channels involve persistent sessions, local host access, or user-delegated OAuth scopes with high blast radius.

| Channel | Auth Pattern | Secret Scope | Blast Radius | Hardening |
|---|---|---|---|---|
| WhatsApp | QR pairing session | Persistent messaging identity/session | High | Protect session files at rest, isolate host, use allowlists, re-pair on compromise |
| Signal | Linked account/session | Local account/session + host permissions | High | Harden host OS, dedicated service user, strict filesystem permissions, monitor bridge processes |
| iMessage (legacy) | Local macOS permissions | Local account/session + host permissions | High | Harden host OS, dedicated service user, strict filesystem permissions |
| Twitch | OAuth token | User delegated scopes / refresh tokens | High | Minimize OAuth scopes, enforce re-consent/revocation playbooks, separate auth profiles |
| Zalo Personal | QR session | Persistent messaging identity/session | High | Protect session files at rest, isolate host, use allowlists, re-pair on compromise |

### Medium-High Risk

Service or account-level API scopes with moderate-to-high blast radius.

| Channel | Auth Pattern | Blast Radius | Hardening |
|---|---|---|---|
| Discord | Bot token | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| LINE | Channel token/secret | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| Matrix | Token/password login | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| Mattermost | Bot token + base URL | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| Slack | appToken + botToken | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| Telegram | Bot token | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| WebChat | Gateway auth token | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |
| Zalo Bot API | App creds/token | Medium-High | Dedicated keys per integration, set rate limits, rotate regularly |

### Medium Risk

Provider or channel-scoped access with contained blast radius.

| Channel | Auth Pattern | Hardening |
|---|---|---|
| BlueBubbles | Server creds | Least-privilege, isolate per integration, rotate every 60-90 days |
| Feishu | App credentials | Least-privilege, isolate per integration, rotate every 60-90 days |
| Google Chat | Service account credentials | Least-privilege, isolate per integration, rotate every 60-90 days |
| Microsoft Teams | Bot app credentials | Least-privilege, isolate per integration, rotate every 60-90 days |
| Nextcloud Talk | Bot secret | Least-privilege, isolate per integration, rotate every 60-90 days |
| Nostr | Private key | Least-privilege, isolate per integration, rotate every 60-90 days |
| Tlon (Urbit) | URL + login code | Least-privilege, isolate per integration, rotate every 60-90 days |

---

## Model Providers

### High Risk

OAuth-based providers where compromise exposes user-delegated scopes and refresh tokens.

| Provider | Auth Pattern | Blast Radius | Hardening |
|---|---|---|---|
| Google Antigravity | OAuth login | High | Minimize scopes, enforce re-consent/revocation, separate auth profiles per agent |
| Google Gemini CLI | OAuth login | High | Minimize scopes, enforce re-consent/revocation, separate auth profiles per agent |
| OpenAI Code (Codex) | OAuth login | High | Minimize scopes, enforce re-consent/revocation, separate auth profiles per agent |
| Qwen Portal | OAuth device-code | High | Minimize scopes, enforce re-consent/revocation, separate auth profiles per agent |

### Medium-High Risk

API-key-based providers with service/account scope.

| Provider | Auth Pattern | Hardening |
|---|---|---|
| Anthropic | API key / setup-token | Dedicated keys, spend/rate limits, rotate regularly |
| Cerebras | API key | Dedicated keys, spend/rate limits, rotate regularly |
| GitHub Copilot | Token | Dedicated keys, spend/rate limits, rotate regularly |
| Google Gemini (API) | API key | Dedicated keys, spend/rate limits, rotate regularly |
| Groq | API key | Dedicated keys, spend/rate limits, rotate regularly |
| Mistral | API key | Dedicated keys, spend/rate limits, rotate regularly |
| OpenAI | API key | Dedicated keys, spend/rate limits, rotate regularly |
| OpenCode Zen | API key | Dedicated keys, spend/rate limits, rotate regularly |
| OpenRouter | API key | Dedicated keys, spend/rate limits, rotate regularly |
| Vercel AI Gateway | API key | Dedicated keys, spend/rate limits, rotate regularly |
| xAI | API key | Dedicated keys, spend/rate limits, rotate regularly |
| Z.AI (GLM) | API key | Dedicated keys, spend/rate limits, rotate regularly |

### Medium Risk

| Provider | Auth Pattern | Hardening |
|---|---|---|
| Amazon Bedrock | AWS auth | Least-privilege IAM, isolate per integration, rotate every 60-90 days |
| GLM Models | Provider auth | Least-privilege, isolate per integration |
| Google Vertex | ADC / gcloud auth | Least-privilege, isolate per integration, rotate every 60-90 days |
| MiniMax | Provider auth | Least-privilege, isolate per integration |
| Qianfan | Provider auth | Least-privilege, isolate per integration |

### Low Risk

| Provider | Auth Pattern | Hardening |
|---|---|---|
| Ollama | No key (local server) | Bind to localhost, patch regularly, restrict local access |

---

## Plugin Packages

All published `@openclaw/*` plugins are assessed at **medium-high risk** due to their ability to register tools, channels, and hooks that execute with runtime-configured credentials.

| Hardening Recommendation |
|---|
| Pin versions and verify provenance |
| Review permissions and code before installation |
| Run with least privilege |
| Audit plugin-registered tools and hooks |

Applies to: `@openclaw/bluebubbles`, `@openclaw/diagnostics-otel`, `@openclaw/discord`, `@openclaw/feishu`, `@openclaw/lobster`, `@openclaw/matrix`, `@openclaw/msteams`, `@openclaw/nextcloud-talk`, `@openclaw/nostr`, `@openclaw/voice-call`, `@openclaw/zalo`, `@openclaw/zalouser`.

---

## Universal Hardening Checklist

:::warning
These recommendations apply across all integration types.
:::

1. **Least privilege**: Grant only the scopes and permissions the agent actually needs.
2. **Credential isolation**: Use separate credentials per integration and per agent.
3. **Rotation schedule**: Rotate API keys every 60-90 days; revoke immediately on compromise.
4. **Audit logging**: Enable audit logs for all credential access and API calls.
5. **Host hardening**: For local integrations (Signal, iMessage, WhatsApp), harden the host OS with dedicated service users and strict filesystem permissions.
6. **Network restriction**: Bind local runtimes (Ollama, Sonos, Hue) to localhost.
7. **Plugin hygiene**: Pin plugin versions, verify provenance, review code.
8. **Session protection**: For QR-paired sessions (WhatsApp, Zalo Personal), protect session files at rest and re-pair on compromise.

---

:::tip Download
For the complete dataset with all fields (risk profiles, rotation difficulty scores, source documentation links):
- [Download CSV](/assets/openclaw_official_bundled_risk_matrix.csv)
- [Download XLSX](/assets/openclaw_official_bundled_risk_matrix.xlsx)
:::
