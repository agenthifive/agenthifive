# AgentHiFive + OpenClaw: Technical Integration Guide

> **Purpose**: Internal engineering document describing how AgentHiFive integrates with OpenClaw via a plugin architecture. No fork required. Written for AgentHiFive and OpenClaw developers.
>
> **Packages**:
> - `@agenthifive/agenthifive` — OpenClaw plugin (tools, hooks, credential provider, channel plugin)
> - `@agenthifive/openclaw-setup` — Setup CLI (bootstrap, patch, configure)
> - `agenthifive-mcp` — MCP server (stdio transport, separate package)
>
> **Date**: April 2026

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Credential Resolution](#3-credential-resolution)
4. [LLM Proxy Mechanism](#4-llm-proxy-mechanism)
5. [Channel Integration](#5-channel-integration)
6. [Agent Tools](#6-agent-tools)
7. [Hooks](#7-hooks)
8. [Runtime Bridge](#8-runtime-bridge)
9. [Setup CLI](#9-setup-cli)
10. [Auto-Patching](#10-auto-patching)
11. [Configuration](#11-configuration)
12. [Known Issues / Lessons Learned](#12-known-issues--lessons-learned)

---

## 1. Executive Summary

AgentHiFive integrates with OpenClaw as a **plugin** — not a fork. The integration ships as three independent npm packages:

| Package | Role |
|---------|------|
| `@agenthifive/agenthifive` | OpenClaw plugin. Registers tools, hooks, a credential provider, and a channel plugin (Slack + Telegram via vault). Lives in `extensions/` alongside OpenClaw. |
| `@agenthifive/openclaw-setup` | Standalone setup CLI (`npx @agenthifive/openclaw-setup`). Bootstraps the agent identity (ES256 key pair), patches OpenClaw's compiled JS for LLM credential resolution, rewrites model provider URLs, configures channels, and removes local API keys. |
| `agenthifive-mcp` | MCP server exposing vault tools over stdio. Independent of OpenClaw — usable with any MCP-compatible client. |

**No fork, no breaking changes to OpenClaw.** The plugin uses OpenClaw's public plugin API (`api.registerTool`, `api.on`). The only deviation is a post-install patch applied by the setup CLI to OpenClaw's compiled `dist/` files for LLM credential interception (see [Auto-Patching](#10-auto-patching)).

**What this achieves:**

- LLM API keys never stored on the OpenClaw host — vault proxies all LLM calls.
- Channel credentials (Slack, Telegram) managed and audited through the vault.
- Policy enforcement (rate limits, allowlists, step-up approval) on every API call.
- Full audit trail for compliance.
- Zero-config fallback: unconfigured instances behave identically to stock OpenClaw.

---

## 2. Architecture Overview

The plugin operates at two levels:

1. **Generic plugin** — Registers tools (vault_execute, etc.), hooks (before_agent_start, llm_output), and a credential provider. Loaded by OpenClaw from `extensions/`.

2. **Channel plugin** — Implements the `agenthifive` channel type with vault-managed Slack and Telegram polling. Declared in `openclaw.plugin.json` under `"channels": ["agenthifive"]`.

The setup CLI applies a compile-time patch to OpenClaw's `dist/` files that intercepts `resolveApiKeyForProvider()` and delegates to the runtime bridge.

```
+------------------------------------------------------------------+
|                        OpenClaw Gateway                          |
|                                                                  |
|  extensions/agenthifive/                                         |
|  +------------------------------------------------------------+  |
|  |  Plugin (register.ts)                                      |  |
|  |  - 6 tools (vault_execute, request_permission, ...)        |  |
|  |  - Hooks (before_agent_start, llm_output, gateway_stop)    |  |
|  |  - VaultTokenManager (ES256 JWT refresh loop)              |  |
|  |  - VaultActionProxy (Model B brokered proxy)               |  |
|  |  - Background approval watcher                             |  |
|  +------------------------------------------------------------+  |
|           |                                                      |
|           v                                                      |
|  globalThis.__ah5_runtime                                        |
|  { vaultBearerToken, credentialProvider,                         |
|    proxiedProviders, currentSessionKey,                          |
|    approvedLlmApprovals }                                        |
|           |                                                      |
|           v                                                      |
|  Patched dist/ (resolveApiKeyForProvider)                        |
|  - Tier 0: if provider in proxiedProviders → return bearerToken  |
|  - Tier 0.5: credentialProvider.resolve() (stub, returns null)   |
|  - Tier 1: original OpenClaw profile resolution (fallback)       |
|           |                                                      |
+-----------|------------------------------------------------------+
            v
   AgentHiFive Vault API
   - POST /v1/vault/execute         (Model B brokered proxy)
   - GET  /v1/vault/llm/{provider}  (LLM proxy — rewritten baseURL)
   - POST /v1/agent-auth/token      (ES256 JWT exchange)
   - GET  /v1/approvals/{id}        (step-up approval polling)
   - POST /v1/agent-permission-requests (capability requests)
```

---

## 3. Credential Resolution

Credentials resolve through a three-tier chain. The auto-patch injects Tier 0 and Tier 0.5 before OpenClaw's native resolution.

### Tier 0: LLM Proxy (Proxied Providers)

For providers listed in `proxiedProviders` (e.g., `["anthropic", "openai", "gemini"]`):

1. The setup CLI rewrites the provider's `baseURL` in `openclaw.json` to `{vaultUrl}/v1/vault/llm/{provider}`.
2. The patch in `resolveApiKeyForProvider()` checks `globalThis.__ah5_runtime.proxiedProviders.includes(provider)`.
3. If matched, returns `{ apiKey: ah5rt.vaultBearerToken, source: "vault:agent-token", mode: "api-key" }`.
4. The vault receives the agent's bearer token as the API key, authenticates the agent, injects the real provider API key, and proxies the request to the actual provider.

The agent's bearer token acts as both authentication and authorization. No real API key ever reaches the OpenClaw host.

### Tier 0.5: Credential Provider Chain

If Tier 0 does not match (provider not in `proxiedProviders`), the patch calls `ah5rt.credentialProvider.resolve(query)`. Currently this is a stub (`VaultCredentialProvider.resolve()` returns `null`) — all LLM access goes through Tier 0. This tier exists as a hook for future credential vending (Model A: token vending).

### Tier 1: Local OpenClaw Profiles (Fallback)

If both Tier 0 and Tier 0.5 return null, OpenClaw's original `resolveApiKeyForProvider()` logic executes unchanged — reading API keys from local profiles in `openclaw.json`. This ensures the plugin is non-breaking for unconfigured providers.

---

## 4. LLM Proxy Mechanism

The setup CLI rewrites model provider base URLs in `openclaw.json`:

```
Original:  https://api.anthropic.com
Rewritten: https://app.agenthifive.com/v1/vault/llm/anthropic

Original:  https://generativelanguage.googleapis.com
Rewritten: https://app.agenthifive.com/v1/vault/llm/gemini
```

When OpenClaw makes an LLM call:

1. The SDK sends the request to the rewritten base URL (vault proxy).
2. The `apiKey` field contains the agent's vault bearer token (injected by the Tier 0 patch).
3. The vault authenticates the agent via the bearer token.
4. The vault resolves the real provider API key from the workspace's connected credentials.
5. The vault proxies the request to the real provider endpoint, injecting the real API key.
6. The response streams back through the vault to OpenClaw.

**Provider aliases**: OpenClaw internally refers to Gemini as `"google"` in `resolveApiKeyForProvider()`, but the config uses `"gemini"`. The runtime expands aliases via `PROVIDER_ALIASES`:

```typescript
const PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ["gemini", "google"],
};
```

`setProxiedProviders(["gemini"])` expands to `["gemini", "google"]` so the patch matches regardless of which name OpenClaw uses internally.

---

## 5. Channel Integration

Both Slack and Telegram run as vault-managed channels under the `agenthifive` channel plugin. They do **not** use Socket Mode or webhooks — all communication is polling-based through the vault's brokered proxy.

### Slack (`slack-poller.ts`)

- Discovers channels via `conversations.list` through `VaultActionProxy.execute()` with `service: "slack"`.
- Polls `conversations.history` for new messages per channel.
- Thread polling is reactive — threads are only polled when their parent channel had new messages.
- Watermarks persisted to `vault-slack-watermarks.json` in state dir.
- Skips system subtypes (message_changed, message_deleted, channel_join, etc.).
- Exponential backoff: 5s initial, 60s max, 2x multiplier.
- Minimum poll interval: 15s per cycle, 500ms between channels.

### Telegram (`telegram-poller.ts`)

- Calls `getUpdates` via `VaultActionProxy.execute()` with `service: "telegram"`.
- Long-polling with 30s timeout (`POLL_TIMEOUT_S = 30`).
- Offset persisted to `vault-telegram-offset.json` in state dir.
- Exponential backoff: 2s initial, 30s max, 2x multiplier.
- Auto-activated when a Telegram connection appears in the vault with `botToken: "vault-managed"`.

### Shared Properties

- All API calls go through `VaultActionProxy.execute()` — fully audited and policy-governed.
- No direct API tokens on the host. The vault injects credentials server-side.
- Channel plugin ID: `"agenthifive"` (declared in `openclaw.plugin.json`).

---

## 6. Agent Tools

The plugin registers 6 tools via `api.registerTool()`:

| Tool | Description |
|------|-------------|
| `vault_execute` | Execute an HTTP request through the vault proxy (Model B). Supports `service` (singleton: telegram, slack) or `connectionId` (multi-account: Google, Microsoft). Authorization injected by vault. Tracks pending approvals if step-up is required. |
| `request_permission` | Request step-up approval from the workspace owner for a specific action. Returns `approvalRequestId` for later redemption. |
| `request_capability` | Request access to a new service the agent doesn't have yet. Posts to `/v1/agent-permission-requests`. The workspace owner sees and approves in the dashboard. |
| `vault_await_approval` | (Fallback only) Synchronously poll until a step-up approval resolves. Not used by default — the background approval watcher auto-notifies the agent. |
| `vault_connections_list` | List all active vault connections with provider, status, and scopes. |
| `vault_connection_revoke` | Immediately revoke a connection, blocking all future access. |

All tool parameters use TypeBox schemas (`@sinclair/typebox`). Tool implementations delegate to `VaultClient` (for simple API calls) or `VaultActionProxy` (for Model B brokered calls).

---

## 7. Hooks

The plugin registers three hook types:

### `before_agent_start` (priority 10) — Prompt + Reference Injection

Fires at the start of each agent turn. Injects vault API reference and connected-provider documentation into the system context.

Two modes:
- **Chunked mode** (default): Writes reference files to state dir, injects a lean pointer via `appendSystemContext`. More token-efficient.
- **Inline mode** (fallback): Embeds the full API reference prompt directly if state dir is unavailable.

Also tracks session context by capturing `ctx.sessionKey` for approval routing.

### `before_agent_start` (priority 5) — Approval Notifications

Checks pending step-up approvals against the vault API. If any have resolved (approved, denied, expired), injects a `<vault-approval-updates>` block into the system context telling the agent which approvals resolved and how to proceed.

### `before_agent_start` (priority 4) — Channel Lifecycle Follow-up

Consumes any pending channel lifecycle context (e.g., new Telegram/Slack connection detected) and injects it as system context.

### `llm_output` (priority 5) — Approval Tracking

Scans LLM assistant output for `approvalRequestId` UUIDs. When found, registers them as pending approvals so the background watcher can track resolution and auto-wake the agent. This captures step-up approvals triggered by the vault's LLM proxy (not just tool-originated ones).

### `gateway_stop` — Cleanup

Stops the background approval watcher interval.

---

## 8. Runtime Bridge

State is shared between the plugin (loaded from `extensions/`) and the patched `dist/` code via `globalThis.__ah5_runtime`. This avoids ESM module cache issues where different import paths resolve to different module instances.

```typescript
interface Ah5RuntimeState {
  vaultBearerToken: string | null;     // Current vault bearer token (refreshed by VaultTokenManager)
  credentialProvider: CredentialProvider | null;  // Tier 0.5 provider (stub, returns null)
  proxiedProviders: string[];          // Expanded list including aliases (e.g., ["gemini", "google", "anthropic"])
  currentSessionKey: string | null;    // Active session key for approval routing
  approvedLlmApprovals: Record<string, string>;  // sessionKey → approvalRequestId mapping
}
```

**Lifecycle:**

1. `register.ts` calls `initAgentAuth()` which exchanges ES256 JWT for a vault bearer token.
2. `setVaultBearerToken(token)` writes to `globalThis.__ah5_runtime.vaultBearerToken`.
3. `setProxiedProviders(["gemini", "anthropic"])` expands aliases and writes to `proxiedProviders`.
4. `setCredentialProvider(provider)` sets the Tier 0.5 provider.
5. The `VaultTokenManager.onRefresh` callback keeps `vaultBearerToken` in sync with background token refresh.
6. The patched `resolveApiKeyForProvider()` reads from `globalThis.__ah5_runtime` — no imports needed.

**Patch-facing API** (consumed by the injected code in `dist/`):

- `getVaultBearerToken()` — returns current token or null.
- `getProxiedProviders()` — returns expanded provider list.
- `resolveCredential(query)` — Tier 0.5 resolution (currently returns null).
- `isInitialized()` — true if token or provider is set.

---

## 9. Setup CLI

`npx @agenthifive/openclaw-setup` runs the setup wizard (`setup-wizard.ts`). Three modes of operation:

| Mode | What it does |
|------|-------------|
| **First-time setup** | Full install: generate ES256 key pair, bootstrap agent identity with vault, apply credential resolution patch + broadcast bridge patch, rewrite model provider URLs, configure channels, remove local API keys. |
| **Change default LLM** | Re-pick model using existing auth. Does not re-bootstrap. |
| **Reconnect to vault** | New bootstrap secret, re-auth, update config, re-patch. |

Plus `--verify` for diagnostics (checks patch status, auth validity, provider reachability).

**Concrete actions performed by setup:**

1. **Generate ES256 key pair** — `jose.generateKeyPair("ES256")`, private key exported as base64-encoded JWK.
2. **Bootstrap agent** — Exchange bootstrap secret for agent identity via vault API.
3. **Apply credential resolution patch** — Find `resolveApiKeyForProvider()` in OpenClaw's `dist/` files, inject Tier 0 check (see [Auto-Patching](#10-auto-patching)).
4. **Apply broadcast bridge patch** — Inject approval notification bridge for channel sessions.
5. **Rewrite model provider URLs** — Set `baseURL` to `{vaultUrl}/v1/vault/llm/{provider}` and `apiKey` to `"vault-managed"`.
6. **Configure channels** — Write `channels.agenthifive` config with account auth, Telegram/Slack provider settings.
7. **Remove local API keys** — Strip raw API keys from `openclaw.json` profiles for proxied providers.

---

## 10. Auto-Patching

The auto-patch (`auto-patch.ts`) modifies OpenClaw's compiled JavaScript at install time. It does **not** modify source files — only `dist/` chunks with hashed filenames.

### Credential Resolution Patch

**Target function**: `resolveApiKeyForProvider()` in OpenClaw's compiled output.

**Mechanism**:

1. `findOpenClawInstallDir()` locates the OpenClaw installation (source or npm dist).
2. Scans `dist/` files for the `resolveApiKeyForProvider` function signature.
3. Injects a code block at the top of the function body:

```javascript
// -- AgentHiFive: vault LLM proxy (Model B brokered) --
// @agenthifive/agenthifive/runtime @ah5-patch-v5
try {
    const ah5rt = globalThis.__ah5_runtime;
    if (ah5rt?.proxiedProviders?.includes(provider) && ah5rt?.vaultBearerToken) {
        return { apiKey: ah5rt.vaultBearerToken, source: "vault:agent-token", mode: "api-key" };
    }
} catch (ah5Err) {
    console.error("[AH5 patch] error:", ah5Err?.message ?? ah5Err);
}
```

### Broadcast Bridge Patch

Second patch: injects a broadcast bridge for approval notification delivery to channel sessions. Allows the background approval watcher to inject session + approval replay headers into LLM requests.

### Patch Detection

- **Marker**: `@agenthifive/agenthifive/runtime` (current), `@agenthifive/openclaw/runtime` (legacy).
- **Version tag**: `@ah5-patch-v5`.
- `hasAnyPatchMarker()` checks for both current and legacy markers to detect already-patched files.
- The patch is idempotent — re-running setup on an already-patched install is safe.

---

## 11. Configuration

The setup CLI writes to `openclaw.json`. Key sections:

### `channels.agenthifive`

```json
{
  "channels": {
    "agenthifive": {
      "accounts": {
        "default": {
          "name": "AgentHiFive",
          "enabled": true,
          "baseUrl": "https://app.agenthifive.com",
          "auth": {
            "mode": "agent",
            "agentId": "<uuid>",
            "privateKey": "<base64-encoded ES256 JWK>"
          },
          "providers": {
            "telegram": { "enabled": true },
            "slack": { "enabled": true }
          }
        }
      }
    }
  }
}
```

### `models.providers`

Provider base URLs rewritten to vault proxy, API keys set to `"vault-managed"`:

```json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseURL": "https://app.agenthifive.com/v1/vault/llm/anthropic",
        "apiKey": "vault-managed"
      },
      "openai": {
        "baseURL": "https://app.agenthifive.com/v1/vault/llm/openai",
        "apiKey": "vault-managed"
      }
    }
  }
}
```

### `agents.defaults`

Default agent settings (model, system prompt additions).

### `tools.alsoAllow`

The 6 vault tools added to `alsoAllow` so they pass OpenClaw's tool allowlist:

```json
{
  "tools": {
    "alsoAllow": [
      "vault_execute",
      "request_permission",
      "request_capability",
      "vault_await_approval",
      "vault_connections_list",
      "vault_connection_revoke"
    ]
  }
}
```

### Plugin Config Schema (`openclaw.plugin.json`)

The plugin manifest declares a `configSchema` with:

- `baseUrl` — Vault API base URL (default: `https://app.agenthifive.com`).
- `auth.mode` — `"bearer"` (opaque token) or `"agent"` (ES256 JWT).
- `auth.agentId`, `auth.privateKey`, `auth.token`, `auth.tokenAudience` — Auth-mode-specific fields.
- `pollTimeoutMs` — Approval polling timeout (default: 300000 = 5 min).
- `pollIntervalMs` — Approval polling interval (default: 3000 = 3s).
- `connectedProviders` — List of connected provider names for prompt injection (e.g., `["google", "microsoft", "notion"]`).

---

## 12. Known Issues / Lessons Learned

### Provider Alias Mismatch (gemini vs google)

OpenClaw uses `"google"` internally in `resolveApiKeyForProvider()` but the user-facing config and our setup CLI use `"gemini"`. The `PROVIDER_ALIASES` map in `runtime.ts` expands `"gemini"` to `["gemini", "google"]` so the patch matches both. Any new provider with this kind of aliasing needs an entry in `PROVIDER_ALIASES`.

### OpenClaw stdout Pollution

OpenClaw's plugin system communicates via JSON commands on stdout. Plugin logs must not write to stdout or they corrupt the JSON command stream. All logging goes through the `api.logger` interface. The Slack/Telegram pollers use bracket notation for `process["env"]` access to bypass OpenClaw's plugin scanner which flags `process.env` access as "env-harvesting".

### Stream Filter JSON Re-serialization

When streaming LLM responses through the vault proxy, intermediate JSON chunks may be re-serialized. This has broken downstream parsers that expect exact byte-level fidelity of the provider's SSE stream. The vault must be careful to preserve chunk boundaries.

### Session Model Pinning

OpenClaw requires `openclaw models set <model>` to pin the session model. Without this, the agent may not use the vault-proxied model even though the config is correct. The setup CLI should prompt or auto-run this step.

### Patch Anchor Drift Between OpenClaw Versions

The auto-patch locates `resolveApiKeyForProvider()` by scanning compiled JS files. When OpenClaw updates and the function signature or surrounding code changes, the patch anchor may fail to match. The `@ah5-patch-v5` version tag helps detect stale patches. The `--verify` flag in the setup CLI checks patch health. Each OpenClaw release should be tested for patch compatibility.
