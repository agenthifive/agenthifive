---
title: Credential Architecture
sidebar_position: 4
sidebar_label: "Credential Architecture"
description: "Analysis of OpenClaw's credential storage, access patterns, and the insertion points where AgentHiFive can serve as a centralized vault."
---

# Credential Architecture

This page summarizes how OpenClaw stores and resolves credentials across its ~52 official integration points, and identifies the surgical insertion points where AgentHiFive can serve as a centralized credential vault.

:::info Source
Condensed from the full [Credential Architecture Analysis](https://github.com/AH5-AgentHiFive/AgentH5/blob/main/Doc/Integrations/OpenClaw/CREDENTIAL_ARCHITECTURE_ANALYSIS.md) (578 lines). Based on analysis of `github.com/openclaw/openclaw` HEAD as of 2026-02-09.
:::

---

## Executive Summary

OpenClaw handles ~52 official integration points (20 channels, 27+ model providers, 5 plugin-config integrations) with **no centralized credential abstraction**. Credentials are stored in plaintext across three locations and accessed via direct property reads.

However, the access patterns converge on **3 main insertion points** that cover **all 49 credential-bearing integrations**:

| Insertion Point | Integrations Covered | Difficulty |
|---|---|---|
| **IP-2**: Core channel resolvers (plugin-sdk re-exports) | 7 core channels | Low (single SDK) |
| **IP-2b**: Extension-local resolvers | 12 extension channels | Medium (12 functions, same pattern) |
| **IP-3**: `resolveApiKeyForProvider()` | All 27+ model providers | Low (single async function) |

---

## Current Credential Storage Layers

### Layer 1: `~/.openclaw/openclaw.json`

The primary config file (JSON5 format), loaded by `loadConfig()` in `src/config/io.ts` with 200ms in-memory caching. Contains channel tokens, model provider API keys, gateway auth, and plugin config. Supports `${ENV_VAR}` substitution and `tokenFile`/`secretFile` indirection at load time.

### Layer 2: `~/.openclaw/auth-profiles.json`

Model provider credentials with `0o600` file permissions and atomic updates via `proper-lockfile`. Stores three credential types:

- **`api_key`**: `{ type: "api_key", provider, key, email?, metadata? }`
- **`token`**: `{ type: "token", provider, token, expires?, email? }`
- **`oauth`**: `{ type: "oauth", provider, access, refresh, expires, email?, clientId? }`

Also tracks profile ordering, last-good profiles, and round-robin usage statistics.

### Layer 3: File-based sessions

Platform-specific session files for WhatsApp (Baileys auth state in `~/.openclaw/oauth/whatsapp/`), Matrix (credentials JSON), Signal (local `signal-cli` daemon), and iMessage (macOS system auth).

---

## Insertion Point Analysis

### IP-2: Core Channel Resolvers

Seven core channels resolve credentials through functions in `src/` that are re-exported via `openclaw/plugin-sdk`:

| Channel | Resolver Function | Sync/Async | Credential Type |
|---|---|---|---|
| Telegram | `resolveTelegramToken()` | sync | Bot token |
| Discord | `resolveDiscordToken()` | sync | Bot token |
| Slack | `resolveSlackAccount()` | sync | Bot token + App token |
| LINE | `resolveLineAccount()` | sync | Access token + Secret |
| WhatsApp | `resolveWhatsAppAccount()` | **async** | Baileys session |
| Signal | `resolveSignalAccount()` | sync | Local RPC URL (no secret) |
| iMessage | `resolveIMessageAccount()` | sync | CLI path (no secret) |

**Resolution priority**: account-specific config -> base config -> tokenFile -> env var (default account only).

**Difficulty**: Low-medium. Most are sync today, so async conversion requires updating callers. WhatsApp is already async.

### IP-2b: Extension Channel Resolvers

Twelve extension channels each define their own resolver following the same pattern (read `cfg.channels.{name}.*` + env fallback). They are not centralized but can be migrated to a shared `resolveChannelCredential()` helper incrementally.

Covers: MS Teams, Mattermost, Feishu, Google Chat, Twitch, Zalo, Zalo Personal, Nextcloud Talk, Matrix, Nostr, Tlon, BlueBubbles.

### IP-3: `resolveApiKeyForProvider()`

The single most valuable insertion point. All 27+ model providers resolve through one async function in `src/agents/model-auth.ts` with a 6-tier fallback chain:

1. **Tier 0** -- Explicit profile ID
2. **Tier 1** -- AWS-SDK auth override
3. **Tier 2** -- Auth profile order (config -> stored -> round-robin)
4. **Tier 3** -- Environment variable lookup
5. **Tier 4** -- Custom config key (`models.providers[x].apiKey`)
6. **Tier 5** -- Implicit AWS fallback (Bedrock only)

:::tip Key Insight
This is the cleanest insertion point in the entire codebase -- already async, already has the right shape for adding a "Tier 0.5: ask vault first" step.
:::

### Other Insertion Points

| Point | What | Verdict |
|---|---|---|
| **IP-1**: `loadConfig()` | Single entry point for all config loading | Too invasive for MVP (sync, ~50 call sites) |
| **IP-4**: Auth Profile Store | `auth-profiles.json` file store | Optional if IP-3 handles vault |
| **IP-5**: Plugin API creation | Where `OpenClawPluginApi` is constructed | Low difficulty, additive, non-breaking |

---

## Coverage Matrix

| Insertion Point | Channels | Model Providers | Plugin-Config | Total |
|---|---|---|---|---|
| IP-2 (core resolvers) | 7 | -- | -- | 7 |
| IP-2b (extension resolvers) | 12 | -- | -- | 12 |
| IP-3 (resolveApiKeyForProvider) | -- | 27 | -- | 27 |
| IP-5 (plugin API) | -- | -- | 3 | 3 |
| No change needed | -- | -- | -- | 6 |
| **Total** | **19** | **27** | **3** | **49** |

### Skill-Based Gap

Skills (`gog`, `himalaya`, etc.) operate **outside** the channel/model provider credential system. CLI tools manage their own auth, bypassing all of OpenClaw's resolvers:

| Skill | Data Risk | Interceptable via IP-2/3? |
|---|---|---|
| `gog` (Google Workspace) | Critical -- full Workspace read+write | No |
| `himalaya` (IMAP/SMTP) | Critical -- full email read+write+delete | No |
| Feishu skills | High -- full cloud storage CRUD + permissions | Partially (shares channel credential) |
| `notion` | Medium -- workspace CRUD | No |
| `exec` tool | High -- arbitrary command execution | N/A |

Interception strategies for skills: fork the CLI tool, wrap exec invocations with env injection, or replace with AgentHiFive-native MCP tools.

---

## Recommended Phased Approach

### Phase 1: Model Providers (IP-3)

Modify `resolveApiKeyForProvider()` to check AgentHiFive vault as **Tier 0.5** before the existing fallback chain. **1 file changed**, non-breaking, covers all 27+ model providers immediately.

### Phase 2: Core Channels (IP-2)

Add vault delegation to the 7 core channel resolvers using an async wrapper at the channel startup boundary (which is already async). **7 files changed**, sync resolvers remain unchanged.

### Phase 3: Extension Channels (IP-2b)

Introduce a shared `resolveChannelCredential()` helper in plugin-sdk. Migrate 12 extension resolvers incrementally. Non-breaking per extension.

### Phase 4: Auth Profile Store (IP-4)

Replace local `auth-profiles.json` with vault-backed storage so OAuth refresh tokens never touch disk. **1-2 files changed**, optional if IP-3 already covers vault.

### Phase 5: Skill-Based Integrations

Separate track for CLI tools that manage their own credentials:
- **Fork `gog`** for vault delegation of Google Workspace OAuth
- **Credential env injection** for API-key-based skills
- **Replace with MCP tools** for long-term AgentHiFive-native solution

---

## Key Technical Risks

| Risk | Mitigation |
|---|---|
| Sync-to-async conversion (IP-2) | Use async wrapper at startup boundary, not inside sync resolvers |
| Config caching (200ms TTL) | Credential-level caching with longer TTL in vault provider |
| Vault unreachable | Fall through to local credentials; vault is just another tier that can return nothing |
| OAuth refresh atomicity | Vault handles refresh server-side; `proper-lockfile` equivalent via compare-and-swap |
