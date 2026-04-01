---
title: Fork Roadmap
sidebar_position: 7
sidebar_label: "Fork Roadmap"
description: "Technical implementation plan for the OpenClaw fork — CredentialProvider interface, 5 phases, files modified, testing strategy, and upstream PR approach."
---

# Fork Roadmap

This page describes the technical plan for implementing a pluggable `CredentialProvider` abstraction in our OpenClaw fork, making AgentHiFive the vault backend for all credential operations.

:::info Prerequisite
Read the [Credential Architecture](./credential-architecture.md) page first for the insertion point analysis this plan builds on.
:::

---

## The CredentialProvider Interface

The core abstraction that all credential resolution flows through. It must be optional (existing behavior preserved when unconfigured), async (vault calls are network I/O), and support fallback (return `null` to try the next provider).

```typescript
export type CredentialQuery = {
  kind: "model_provider" | "channel" | "plugin_config";
  provider: string;       // e.g., "openai", "telegram"
  profileId?: string;     // for multi-account setups
  fields?: string[];      // hint about which config fields are needed
};

export type CredentialResult = {
  apiKey?: string;
  extra?: Record<string, string>;  // multi-field creds (e.g., Slack bot+app token)
  source: string;                  // audit/debugging
  mode?: "api-key" | "oauth" | "token" | "aws-sdk";
  cacheTtlMs?: number;            // how long to cache locally
};

export interface CredentialProvider {
  readonly id: string;
  resolve(query: CredentialQuery): Promise<CredentialResult | null>;
  store?(query: CredentialQuery, credential: CredentialResult): Promise<void>;
  revoke?(query: CredentialQuery): Promise<void>;
  isAvailable?(): Promise<boolean>;
}
```

**Design rationale:**

| Choice | Why |
|---|---|
| `kind` field | Allows vault-side policy per credential category |
| `extra` map | Slack needs `botToken` + `appToken`; MS Teams needs `appId` + `appPassword` + `tenantId` |
| `resolve()` returns `null` | Clean fallback chains -- vault returns null, local provider handles it |
| `store()` optional | Local provider does not need remote storage |
| `cacheTtlMs` | Vault tells us "valid for 5 min" -- avoids re-fetching on every call |

---

## Configuration

A new `credentials` section in `openclaw.json`:

```json5
{
  "credentials": {
    "provider": "vault+local",      // "local" | "vault" | "vault+local"
    "vault": {
      "baseUrl": "https://vault.agenthifive.com",
      "auth": { "mode": "api_key", "apiKey": "${AGENTHIFIVE_API_KEY}" },
      "timeoutMs": 5000,            // default
      "cacheTtlMs": 60000           // default
    }
  }
}
```

Three provider modes:
- **`local`** (default): Existing behavior, credentials in local files.
- **`vault`**: Delegate to AgentHiFive vault only.
- **`vault+local`**: Try vault first, fall back to local on miss or error.

---

## Five Phases

### Phase 1: Model Providers (IP-3)

**Goal**: All 27+ model providers can resolve API keys from the vault.

Modify `resolveApiKeyForProvider()` in `src/agents/model-auth.ts` to add a **Tier 0.5** check -- call the vault before the existing 6-tier fallback chain. If the vault returns a credential, use it; otherwise, fall through to existing behavior.

```typescript
// NEW: Tier 0.5 -- Credential Provider (vault delegation)
const credentialProvider = getCredentialProvider(cfg);
const vaultResult = await credentialProvider.resolve({
  kind: "model_provider",
  provider,
  profileId: preferredProfile,
});
if (vaultResult?.apiKey) {
  return {
    apiKey: vaultResult.apiKey,
    profileId: vaultResult.source,
    source: `credential-provider:${credentialProvider.id}`,
    mode: vaultResult.mode ?? "api-key",
  };
}
// ... existing tiers continue unchanged ...
```

**Impact**: Zero breaking changes. When `credentials` config is absent, `LocalCredentialProvider` returns `null` and all existing tiers execute exactly as before.

**Files**: 3 new (`types.ts`, `local-provider.ts`, `vault-provider.ts`, `index.ts`, `types.credentials.ts`) + 2 modified (`model-auth.ts`, `types.openclaw.ts`). Total: ~400 lines added, ~10 modified.

### Phase 2: Core Channels (IP-2)

**Goal**: 7 core channel resolvers delegate to the vault.

Rather than converting sync resolvers to async (which touches dozens of callers), use an **async wrapper at the channel startup boundary**:

```typescript
// At channel startup (already async):
const credProvider = getCredentialProvider(cfg);
const vaultCred = await credProvider.resolve({
  kind: "channel", provider: "telegram", profileId: accountId,
});
const token = vaultCred?.apiKey ?? resolveTelegramToken(cfg, accountId);
```

Sync resolvers remain unchanged. The async vault call happens where the channel is initialized (which is already async). **7 files changed**, one per core channel startup.

### Phase 3: Extension Channels (IP-2b)

**Goal**: 12 extension channel resolvers delegate to the vault.

Export `getCredentialProvider` from `openclaw/plugin-sdk`. Each extension's startup code uses the same async wrapper pattern as Phase 2. Migrations are independent and incremental.

Multi-field credential mapping via `extra`:

| Extension | `apiKey` | `extra` Keys |
|---|---|---|
| MS Teams | appPassword | `appId`, `tenantId` |
| Mattermost | botToken | `baseUrl` |
| Feishu | appSecret | `appId`, `encryptKey`, `verificationToken` |
| Google Chat | service account JSON | (entire JSON as apiKey) |
| Matrix | accessToken | `homeserver`, `userId`, `password` |
| Tlon | code | `ship`, `url` |
| BlueBubbles | password | `serverUrl` |

### Phase 4: Brokered API Proxying (MS Teams + Slack)

**Goal**: Demonstrate AgentHiFive as a policy enforcement proxy, not just a credential vault.

Introduces an `ActionProxy` interface alongside `CredentialProvider`:

```
Agent -> OpenClaw Tool -> AgentHiFive Vault Proxy -> Provider API
                               |
                          Policy Engine
                          +-- Content filter (profanity, PII)
                          +-- Action allowlist (block deletions)
                          +-- Rate limiter
                          +-- Audit logger
```

**MS Teams**: Wrap all Graph API `fetch()` calls through a `fetchGraphApi()` wrapper that routes through the vault proxy. Intercept `sendActivity()` for outgoing messages. Covers 12 Graph API patterns.

**Slack**: Override `apiCall()` on the `@slack/web-api` `WebClient` instance via `createProxiedSlackWebClient()`. All 14 SDK methods route through this single interception point. No SDK fork needed.

**Policies demonstrated**: profanity filter, PII filter, sharing scope restriction, file type restriction, message deletion rate-limiting, directory enumeration limits, channel read allowlists.

**Total Phase 4 diff**: ~290 lines added, ~60 lines modified.

### Phase 5: Skill-Based Integrations

**Goal**: Cover CLI tools (`gog`, `himalaya`) that manage their own credentials outside OpenClaw's resolver system.

Three strategies (can be pursued in parallel):

| Strategy | Scope | Best For |
|---|---|---|
| **Fork the CLI** (e.g., "vault-gog") | Per-tool, full control | PoC demo -- drop-in replacement |
| **Credential env injection** | All API-key skills | Quick wins (Google Places, etc.) |
| **Replace with MCP tools** | Per-tool, native to AgentHiFive | Long-term product play |

**Recommendation**: Fork `gog` for the PoC. It is small, focused, and demonstrates the vault pattern working at the CLI tool level.

---

## Files Modified Inventory

### Phase 1 -- New Files

| File | Lines | Purpose |
|---|---|---|
| `src/credentials/types.ts` | ~50 | CredentialProvider interface |
| `src/credentials/local-provider.ts` | ~15 | Default no-op provider |
| `src/credentials/vault-provider.ts` | ~80 | AgentHiFive vault backend |
| `src/credentials/index.ts` | ~50 | Factory + ChainedProvider |
| `src/config/types.credentials.ts` | ~30 | Config types |
| `src/credentials/__tests__/*.ts` | ~200 | Tests |

### Phase 1 -- Modified Files

| File | Lines Changed | Change |
|---|---|---|
| `src/config/types.openclaw.ts` | +2 | Add `credentials?` field |
| `src/agents/model-auth.ts` | +10 | Vault Tier 0.5 |
| `src/plugin-sdk/index.ts` | +3 | Re-export CredentialProvider |

### Phase 4 -- New Files

| File | Lines | Purpose |
|---|---|---|
| `src/credentials/action-proxy.ts` | ~30 | ActionProxy interface |
| `src/credentials/vault-action-proxy.ts` | ~60 | Vault-backed ActionProxy |
| `src/slack/client-proxy.ts` | ~90 | Proxied WebClient factory |
| `extensions/msteams/src/graph-proxy.ts` | ~50 | Graph API proxy wrapper |

### Grand Total (All Phases)

| Metric | Count |
|---|---|
| New files | ~11 |
| New lines | ~655 |
| Modified files | ~15 |
| Modified lines | ~75 |

---

## Testing Strategy

### Unit Tests

Located in `src/credentials/__tests__/`:

| Test | What It Verifies |
|---|---|
| `local-provider.test.ts` | Always returns null (pass-through) |
| `vault-provider.test.ts` | Mock fetch, cache behavior, timeout fallback |
| `chain-provider.test.ts` | Vault -> local fallback chain |
| `integration.test.ts` | `resolveApiKeyForProvider()` with mock vault |

**Key scenarios tested:**

1. No config -> `LocalCredentialProvider` -> existing behavior unchanged
2. Vault configured, returns key -> key used, local tiers skipped
3. Vault configured, returns null -> falls through to existing tiers
4. Vault configured, unreachable -> falls through to existing tiers
5. Vault configured, timeout -> falls through within `timeoutMs`
6. Cache hit -> no network call on second resolve within TTL
7. Cache miss after TTL -> fresh vault call
8. Multi-field credentials -> `extra` map properly passed to channel startup

### Integration Testing

Docker Compose setup in `integration-testing/` that starts AgentHiFive API + DB + OpenClaw fork, creates connections with stored credentials, and verifies vault credential resolution with graceful fallback on vault failure.

### Regression Testing

Full OpenClaw test suite (`pnpm test`, `pnpm test:integration`, `pnpm build`) runs after every change to verify zero regressions.

---

## Upstream PR Strategy

### PR Structure

Four independently mergeable PRs, one per phase:

| PR | Title | Breaking? |
|---|---|---|
| 1 | `feat: pluggable CredentialProvider for model providers` | No |
| 2 | `feat: vault delegation for core channel credentials` | No |
| 3 | `feat: vault delegation for extension channel credentials` | No |
| 4 | `feat: brokered API proxying for MS Teams and Slack` | No |

### Socialization Plan

1. **Before coding**: Open a Discussion/RFC on openclaw/openclaw titled "RFC: Pluggable credential backend (vault/KMS support)"
2. **After Phase 1 PoC**: Open PR 1 with working code, full test suite passing, documentation, and demo video
3. **Iterate** based on maintainer feedback before Phases 2-4

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Maintainers reject the approach | RFC Discussion first; design for zero-breaking-change; fork works regardless |
| Sync-to-async breaks callers | Phase 2 uses async wrapper at startup boundary, not inside sync resolvers |
| Vault latency on startup | `timeoutMs` config (default 5s); fallback to local on timeout |
| Vault latency at runtime | In-memory cache with configurable TTL (default 60s) |
| Credential cache staleness | `cacheTtlMs` per-credential from vault; cache cleared on rotation |
| OAuth refresh race conditions | Vault handles refresh server-side; OpenClaw never sees refresh tokens |
| Fork drift from upstream | Rebase `main` weekly; keep diff minimal (3 files modified in Phase 1) |
| Proxy latency on every API call | Phase 4 proxy is opt-in per channel; direct fetch is the default |
| Skill CLIs bypass resolvers | Separate interception strategy: fork, env injection, or MCP replacement |
