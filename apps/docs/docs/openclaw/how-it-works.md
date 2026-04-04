---
sidebar_position: 2
title: How It Works
description: Technical architecture of the AgentHiFive + OpenClaw integration — patching, credential resolution, and runtime bridge
---

# How It Works

## Overview

The AgentHiFive + OpenClaw integration makes AgentHiFive the credential backend for OpenClaw so that provider tokens (LLM API keys, bot tokens, OAuth credentials) never live on disk. Instead of storing API keys in OpenClaw's configuration files, all credentials are managed centrally in the AgentHiFive Vault and injected at runtime through a combination of compiled-JS patching, URL rewriting, and a shared in-process runtime bridge.

The integration consists of two packages:

- **`@agenthifive/openclaw-setup`** -- A setup CLI that bootstraps the agent, patches OpenClaw's compiled JS, rewrites model provider config, and installs the plugin.
- **`@agenthifive/openclaw`** -- The OpenClaw plugin that registers vault tools, manages token lifecycle, runs approval watchers, and populates the runtime bridge.

## Architecture Diagram

```
+------------------------------------------------------------------+
|  OpenClaw Process                                                |
|                                                                  |
|  +---------------------------+   +----------------------------+  |
|  |  OpenClaw Gateway         |   |  AgentHiFive Plugin        |  |
|  |  (patched dist/)          |   |  (extensions/)             |  |
|  |                           |   |                            |  |
|  |  resolveApiKeyForProvider |   |  register()                |  |
|  |    +-- AH5 patch -----+  |   |    +-- VaultTokenManager   |  |
|  |    | check proxied    |  |   |    +-- VaultActionProxy    |  |
|  |    | providers, return|  |   |    +-- VaultCredProvider   |  |
|  |    | vault bearer tok |  |   |    +-- approval watcher    |  |
|  |    +------------------+  |   |    +-- session context     |  |
|  |                           |   |    +-- channel plugin     |  |
|  |  applyLocalNoAuthHeader   |   |                            |  |
|  |    +-- AH5 header patch --+   |  Populates at load time:   |  |
|  |    | inject session key  ||   |    globalThis.__ah5_runtime |  |
|  |    | + approval ID       ||   |                            |  |
|  |    +---------------------+|   +----------+-----------------+  |
|  +------------+--------------+              |                    |
|               |                             |                    |
|               +-------- reads from ---------+                    |
|               |                                                  |
|               v                                                  |
|     globalThis.__ah5_runtime                                     |
|     {                                                            |
|       vaultBearerToken,                                          |
|       credentialProvider,                                        |
|       proxiedProviders,                                          |
|       currentSessionKey,                                         |
|       approvedLlmApprovals,                                      |
|       broadcast            (from broadcast bridge patch)         |
|     }                                                            |
+------------------------------------------------------------------+
           |                                    ^
           | HTTPS (bearer token auth)          | ES256 JWT
           v                                    |
+------------------------------------------------------------------+
|  AgentHiFive API (remote)                                        |
|                                                                  |
|  /v1/vault/llm/{provider}   -- LLM proxy (Model B brokered)     |
|  /v1/vault/execute           -- action proxy (Model B brokered)  |
|  /v1/approvals/:id           -- approval status polling          |
|  /v1/agents/bootstrap        -- agent registration               |
|  /v1/capabilities/me         -- connection discovery              |
+------------------------------------------------------------------+
```

## Setup Phase

The setup CLI (`npx @agenthifive/openclaw-setup`) performs a multi-step bootstrap that connects an OpenClaw installation to AgentHiFive. The wizard supports three modes: first-time setup, reconnect (new bootstrap secret), and change-default-model.

### 1. Bootstrap the agent

The CLI generates an ES256 key pair, then calls `POST /v1/agents/bootstrap` with the public key and a one-time bootstrap secret (obtained from the AgentHiFive dashboard). The vault returns an `agentId`. The private key is stored (base64-encoded JWK) in OpenClaw's config file -- it never leaves the machine.

### 2. Discover vault capabilities

Using a short-lived JWT obtained via the new key pair, the CLI calls `GET /v1/capabilities/me` to discover which connections (LLM providers, Telegram, Slack, etc.) the workspace owner has granted to this agent. Connections are classified into:

- **LLM providers** (`category: "llm"`) -- become proxied providers with URL-rewritten config
- **Channel services** (Telegram, Slack) -- offered as vault-managed channel providers
- **Other services** -- registered as connected providers for tool-based access

### 3. Install the plugin

The plugin package is copied to OpenClaw's `~/.openclaw/extensions/agenthifive` directory. This directory is scanned by OpenClaw's plugin loader at startup, which calls `register(api)` on the plugin entry point.

### 4. Patch OpenClaw's compiled JS

The auto-patcher finds all JS chunks in OpenClaw's `dist/` that contain `resolveApiKeyForProvider` and applies two patches:

**a. Credential resolution patch** -- Injected after the `const store = params.store ?? ensureAuthProfileStore(...)` line inside `resolveApiKeyForProvider()`. The patch reads `globalThis.__ah5_runtime` and, if the requested provider is in the `proxiedProviders` list, returns the vault bearer token directly instead of looking up a local API key:

```js
const ah5rt = globalThis.__ah5_runtime;
if (ah5rt?.proxiedProviders?.includes(provider) && ah5rt?.vaultBearerToken) {
    return { apiKey: ah5rt.vaultBearerToken, source: "vault:agent-token", mode: "api-key" };
}
```

**b. Header injection patch** -- Injected inside `applyLocalNoAuthHeaderOverride()`. When the auth source is `"vault:agent-token"`, this patch reads the current session key and any pending LLM approval ID from the runtime bridge and attaches them as HTTP headers (`x-ah5-session-key`, `x-ah5-approval-id`) on the outgoing model request:

```js
if (sessionKey || approvalId) {
    return { ...model, headers: {
        ...model.headers,
        ...(sessionKey ? { "x-ah5-session-key": sessionKey } : {}),
        ...(approvalId ? { "x-ah5-approval-id": approvalId } : {})
    }};
}
```

**c. Broadcast bridge patch** -- Applied separately to gateway chunks that contain `broadcastInternal`. Exposes the gateway's internal `broadcast` function on `globalThis.__ah5_runtime.broadcast` so the plugin's approval watcher can push events directly to the TUI without going through HTTP hooks.

All patches create `.bak` backup files before modifying any chunk. A version marker (`@ah5-patch-v5`) enables safe re-patching when the plugin is upgraded.

### 5. Rewrite model provider config

For each LLM provider discovered in the vault (Anthropic, OpenAI, Gemini, OpenRouter), the setup CLI writes a `models.providers` entry that redirects the base URL:

```json
{
  "anthropic": {
    "baseUrl": "https://app.agenthifive.com/v1/vault/llm/anthropic",
    "apiKey": "vault-managed",
    "models": [...]
  }
}
```

The `apiKey: "vault-managed"` sentinel value tells the plugin which providers are vault-proxied. OpenClaw sees a normal provider config and sends requests to what it believes is the LLM API -- but the URL actually points at the vault.

### 6. Configure the agenthifive channel

If Telegram or Slack connections exist in the vault, the CLI offers to enable the `agenthifive` channel plugin. This writes the channel auth block (agent mode credentials) into the `channels.agenthifive.accounts.default` section of OpenClaw's config. Existing local channel configs can be migrated to vault-managed in the same step.

### 7. Remove local API keys

Because LLM providers are now vault-managed, any local API keys for those providers become unnecessary. The `apiKey` field is set to `"vault-managed"` -- a value that OpenClaw treats as a valid string but that will never authenticate against a real provider, ensuring the patch is the only credential path.

## Credential Resolution Tiers

When OpenClaw calls `resolveApiKeyForProvider(provider)`, credentials are resolved through a tiered system:

### Tier 0: Proxied providers (URL rewrite)

For LLM providers (Anthropic, OpenAI, Gemini, etc.), the credential question is bypassed entirely. The model provider's `baseUrl` already points at the vault proxy (`/v1/vault/llm/{provider}`), and the patched `resolveApiKeyForProvider` returns the vault bearer token as the "API key." The vault receives this bearer token, authenticates the agent, then injects the real provider API key before forwarding the request. OpenClaw never sees the real key.

### Tier 0.5: Credential provider chain

The `VaultCredentialProvider` is registered on the runtime bridge for future use. Currently its `resolve()` method returns `null` -- all LLM access goes through the Tier 0 URL-rewrite path. When credential vending (Model A) is implemented, this tier will query the vault for short-lived API keys.

### Tier 1: Local OpenClaw profiles

If neither Tier 0 nor Tier 0.5 resolves a credential, OpenClaw falls through to its standard local profile resolution (`ensureAuthProfileStore`). This serves as the fallback for any provider that is not vault-managed.

## LLM Proxy Mechanism

The LLM proxy is the core of the "no keys on disk" guarantee for model providers. Here is how a single LLM API call flows:

1. **OpenClaw prepares a model request.** It reads the provider config for, say, Anthropic. The `baseUrl` is `https://app.agenthifive.com/v1/vault/llm/anthropic` and the `apiKey` is `"vault-managed"`.

2. **The patched `resolveApiKeyForProvider` runs.** It checks `globalThis.__ah5_runtime.proxiedProviders` and finds `"anthropic"` in the list. It returns `{ apiKey: <vault-bearer-token>, source: "vault:agent-token" }`.

3. **The patched `applyLocalNoAuthHeaderOverride` runs.** Seeing `source: "vault:agent-token"`, it reads the current `sessionKey` and any pending `approvalId` from the runtime bridge and injects them as headers on the request.

4. **OpenClaw sends the request** to `https://app.agenthifive.com/v1/vault/llm/anthropic/v1/messages` with `Authorization: Bearer <vault-bearer-token>` plus the session/approval headers.

5. **The vault receives the request.** It validates the bearer token (an ES256 JWT signed by the agent's private key), evaluates policies, injects the real Anthropic API key, and forwards the request to `https://api.anthropic.com/v1/messages`.

6. **The response flows back** through the vault to OpenClaw. The entire exchange is transparent to OpenClaw -- it believes it talked directly to Anthropic.

This mechanism works identically for OpenAI, Gemini, and OpenRouter. The vault bearer token serves as a "meta-credential" that authenticates the agent; the vault then substitutes the real provider key server-side.

## Runtime Bridge (`globalThis.__ah5_runtime`)

The runtime bridge solves a fundamental problem: OpenClaw's bundler compiles the gateway into multiple JS chunks, and ESM module caching means different chunks can get different instances of the same module. A normal `import` from the plugin would not be visible inside the patched gateway chunk.

The solution is `globalThis.__ah5_runtime` -- a plain object on the global scope that both the plugin and the patches can read and write without any module import.

### Shape

```typescript
interface Ah5RuntimeState {
  vaultBearerToken: string | null;      // Current JWT for vault auth
  credentialProvider: CredentialProvider | null;  // Tier 0.5 provider
  proxiedProviders: string[];           // e.g. ["anthropic", "openai"]
  currentSessionKey: string | null;     // Active session for header injection
  approvedLlmApprovals: Record<string, string>;  // sessionKey -> approvalId
  broadcast?: Function;                 // Gateway broadcast (from bridge patch)
}
```

### Lifecycle

1. **Plugin loads** (`register()` is called by OpenClaw's plugin loader).
2. **`initAgentAuth()` starts** -- creates a `VaultTokenManager` that exchanges the ES256 private key for a JWT, then starts a background refresh loop.
3. **Runtime bridge is populated:**
   - `setVaultBearerToken(token)` -- writes the JWT to `__ah5_runtime.vaultBearerToken`
   - `setProxiedProviders(["anthropic", "openai", ...])` -- from the plugin config's `proxiedProviders` list
   - `setCredentialProvider(vaultProvider)` -- the `VaultCredentialProvider` instance
   - Token refresh callback updates the bearer token in-place via `onRefresh`
4. **Session context updates** on each `before_agent_start` hook -- writes `currentSessionKey` to the bridge so the header injection patch can read it.
5. **LLM approval state** is synchronized bidirectionally: the plugin writes to both an in-memory Map and `__ah5_runtime.approvedLlmApprovals`; the patch reads and deletes entries from the globalThis object (one-time consumption).
6. **Patched code reads** from `__ah5_runtime` at call time -- no imports needed.

## Approval Workflow

AgentHiFive supports step-up approvals: certain actions require human approval before they execute. The integration handles this through two complementary mechanisms.

### Background approval watcher (polling loop)

The plugin starts a `setInterval` loop (every 5 seconds) that:

1. Loads all pending approvals from disk (`ah5-pending-approvals.json`).
2. For each pending approval, calls `GET /v1/approvals/{approvalRequestId}` using the shared `VaultActionProxy`.
3. Based on the response status:
   - **approved** -- For LLM approvals (`url` starts with `llm://`), stores the approval ID in `approvedLlmApprovals` so the next LLM request can redeem it via the header injection patch. For tool approvals, wakes the agent via `enqueueSystemEvent` + `requestHeartbeatNow`.
   - **denied / expired / consumed** -- Clears any stored approval state and notifies the agent.
   - **pending** -- Keeps the approval in the pending list for the next poll cycle.
4. Saves the updated pending list back to disk.

The watcher interval is `unref()`'d so it does not keep the Node.js process alive for short-lived CLI commands.

### Session context tracking

The `before_agent_start` hook captures the current session key from `ctx.sessionKey` and writes it to both a module-scoped variable and `globalThis.__ah5_runtime.currentSessionKey`. This enables:

- **Approval routing** -- When a `vault_execute` tool call returns a 202 (approval required), the pending approval is tagged with the session key so the watcher knows which session to wake.
- **LLM header injection** -- The patched `applyLocalNoAuthHeaderOverride` reads `currentSessionKey` from the bridge and attaches it as `x-ah5-session-key`. The vault uses this to correlate LLM requests with approval decisions.
- **Approval replay** -- When an LLM approval is granted, the approval ID is stored in `approvedLlmApprovals[sessionKey]`. The header injection patch reads and deletes (consumes) this entry, attaching `x-ah5-approval-id` to the next LLM request for that session.

### Hook-based notification (synchronous path)

In addition to the background watcher, the `before_agent_start` hook also calls `checkPendingApprovals()` synchronously at the start of each agent turn. This injects a `<vault-approval-updates>` block into the system context if any approvals resolved since the last turn -- serving as a reliable fallback when the background watcher's `enqueueSystemEvent` is not available.

### LLM output tracking

The `llm_output` hook scans assistant text for `approvalRequestId` UUIDs. When a vault LLM proxy returns a 202 approval-required response, the LLM's output text includes the approval request ID. The hook extracts this and adds it to the pending approvals list with a `llm://` URL prefix, enabling the approval watcher to handle LLM step-up approvals.

## Channel Plugin

The `agenthifive` channel plugin enables OpenClaw to send and receive messages through Slack and Telegram without storing bot tokens or OAuth credentials locally. All message delivery goes through the vault's brokered proxy.

### Architecture

The channel plugin registers itself with OpenClaw's `createChatChannelPlugin` API using the channel ID `"agenthifive"`. It declares capabilities for direct messages, groups, channels, threads, replies, media, edit, and unsend.

### Sub-provider architecture

A single `agenthifive` channel handles both Slack and Telegram through sub-provider runtimes:

- **Telegram normalizer** (`createTelegramChannelRuntime`) -- Translates OpenClaw's send/receive abstractions into Telegram Bot API calls (`sendMessage`, `sendDocument`) routed through the vault.
- **Slack normalizer** (`createSlackChannelRuntime`) -- Translates into Slack Web API calls (`chat.postMessage`) routed through the vault.

Target routing is automatic: if the `to` address matches Slack's channel ID pattern (`/^[CDGUAW][A-Z0-9]{4,}$/`), the Slack sub-provider handles it; otherwise, Telegram is used.

### Message flow

**Outbound (sending):**

1. OpenClaw calls `sendText()` or `sendMedia()` on the channel plugin.
2. The plugin creates a `VaultActionProxy` (reusing the shared proxy from the main plugin when available).
3. It builds a proxy request with `service: "telegram"` or `service: "slack"` and the appropriate API URL/body.
4. The vault authenticates the agent, injects the real bot token or OAuth token, executes the API call, and returns the response.
5. If the vault returns a 202 (approval required), the action is persisted to disk and the channel approval watcher picks it up.

**Inbound (receiving):**

1. The gateway `startAccount` lifecycle starts inbound gateways for enabled sub-providers (`startTelegramInboundGateway`, `startSlackInboundGateway`).
2. These poll the vault for incoming messages and dispatch them into OpenClaw's channel runtime for agent processing.

### Approval handling for channels

Channel actions that require approval follow a dedicated path:

1. The channel approval watcher (`startChannelApprovalWatcher`) polls pending channel actions.
2. When an approval resolves, the appropriate sub-provider runtime completes the pending action (re-executes the API call with the approval ID).
3. Lifecycle events are persisted to disk and wake the agent session via `enqueueSystemEvent`.

### Account configuration

Each account in the `channels.agenthifive.accounts` config section specifies:

- `baseUrl` -- Vault API endpoint
- `auth` -- Agent mode (agentId + privateKey) or bearer token
- `providers.telegram` -- Enable/disable, DM policy (`balanced`, `open`, `closed`), allowFrom list
- `providers.slack` -- Enable/disable

The plugin resolves account config with sensible defaults and supports multi-account setups, though most installations use a single `default` account.
