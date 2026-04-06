# OpenClaw Upstream PR Design: Runtime Provider Auth Override

> **Purpose**: Rewrite of the OpenClaw upstream PR proposal after the channel-plugin migration. The remaining upstream ask is no longer "general credential providers everywhere." The narrow gap is a public way for an external plugin to exchange or override runtime auth for built-in model providers, so AgentHiFive can keep short-lived rotating vault tokens without patching OpenClaw core.
>
> **Date**: 2026-03-24
>
> **Prerequisites**:
> - [CREDENTIAL_ARCHITECTURE_ANALYSIS.md](./CREDENTIAL_ARCHITECTURE_ANALYSIS.md)
> - [OPENCLAW_TECHNICAL_INTEGRATION.md](./OPENCLAW_TECHNICAL_INTEGRATION.md)
>
> **Status**: Draft

---

## 1. Executive Summary

The original upstream pitch was too broad.

We no longer need OpenClaw changes for channel support:
- Telegram and Slack now work as native channel plugins
- `before_agent_start` usage is public plugin API, not a patch
- channel approvals and lifecycle follow-up can be handled in plugin space

The one remaining place where AgentHiFive still patches OpenClaw is **LLM runtime auth**.

Today we patch OpenClaw so that when a configured provider such as `anthropic`, `openai`, or `openrouter` is vault-managed, OpenClaw uses the **current short-lived vault bearer token** instead of a static API key from config. That patch works, but it is not the right long-term interface.

### New upstream ask

Add a **public runtime-auth override hook for built-in model providers**.

That hook should let a plugin say:

- for provider `anthropic`
- using the already-selected model and configured provider
- here is the runtime credential to use for this request
- optionally with expiry and base URL override

This keeps the best parts of the current architecture:
- OpenClaw still owns built-in provider behavior
- OpenClaw still owns provider quirks and catalog evolution
- AgentHiFive only owns the auth exchange

### Why this is a better pitch

It is much smaller than the old `CredentialProvider` abstraction:
- fewer moving parts
- no channel credential resolution work
- no broadcast ask
- no new general-purpose secret-management framework

It also aligns with APIs OpenClaw already has for provider plugins:
- `prepareRuntimeAuth`
- `resolveUsageAuth`

The gap is that those hooks are available when you **are the provider plugin**, but not when you want to **augment a built-in provider from another plugin**.

---

## 2. What Is Already Solved

### Channels do not need an upstream PR

This was the biggest architectural uncertainty and it is now resolved.

AgentHiFive can integrate Telegram and Slack through OpenClaw's channel-plugin SDK:
- native channel plugin entry
- native inbound/outbound runtime
- approval-aware outbound actions
- no fake-channel prompt-injection ingress

So we should not ask OpenClaw for new channel APIs as part of this PR.

### `before_agent_start` is not a patch

AgentHiFive still uses `before_agent_start` in its generic plugin layer, but that hook is already public plugin API.

This is not an upstream blocker. At most, it is future polish if OpenClaw wants cleaner modern hook surfaces.

### OpenClaw already supports provider-owned runtime auth

The local SDK/runtime already exposes:

- `prepareRuntimeAuth`
- `resolveUsageAuth`

These are real provider-runtime extension points. For example, GitHub Copilot exchanges a source credential into a short-lived runtime token through `prepareRuntimeAuth`.

So the missing capability is not "support rotating runtime auth at all."

The missing capability is:

**let an external plugin do that for an existing built-in provider without replacing that provider entirely.**

---

## 3. Current Problem

### Current architecture

AgentHiFive currently wants to keep using OpenClaw's built-in providers:
- `anthropic`
- `openai`
- `openrouter`

This is desirable because OpenClaw already owns:
- provider-specific capability hints
- model-family quirks
- xhigh / reasoning / modern-model behavior
- transport tweaks
- usage behavior
- catalog evolution

At runtime, however, AgentHiFive does not want OpenClaw to use a static provider API key from config. It wants OpenClaw to use the **current short-lived vault bearer token**.

Today we accomplish that by patching OpenClaw core model auth resolution.

### What the patch does

The patch checks:
- whether the provider is in AgentHiFive's proxied provider list
- whether AgentHiFive runtime state currently has a vault bearer token

If yes, OpenClaw uses that bearer token as the provider API key for the request.

This is effective, but it is still a patch.

### Why the old broad PR is no longer ideal

The previous `CredentialProvider` proposal asked OpenClaw to:
- add a generic credential-provider abstraction
- integrate it into model auth
- integrate it into channel startup
- expose broadcast to plugins
- enrich gateway lifecycle contexts

That proposal tried to solve too many problems at once.

Now that channels are solved in plugin space, the actual upstream gap is much narrower.

---

## 4. Recommended Upstream PR

### Proposal

Add a public hook that lets external plugins override or exchange runtime auth for a built-in provider just before inference.

Working name:
- `registerProviderRuntimeAuthOverride`

The intent is:
- model/provider selection still happens normally
- built-in provider behavior still belongs to OpenClaw
- an external plugin may transform the resolved credential into the actual runtime credential

### Mental model

This is the built-in-provider analogue of `prepareRuntimeAuth`.

Today:
- provider plugins can do runtime auth exchange for the providers they own

Proposed:
- regular plugins can do runtime auth exchange for built-in providers they do **not** own

### Sketch of the API

```ts
export type ProviderRuntimeAuthOverrideContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
  apiKey: string;
  authMode: string;
  profileId?: string;
};

export type ProviderRuntimeAuthOverrideResult = {
  apiKey: string;
  baseUrl?: string;
  expiresAt?: number;
  source?: string;
};

export type ProviderRuntimeAuthOverride = {
  pluginId?: string;
  priority?: number;
  providers: string[];
  run: (
    ctx: ProviderRuntimeAuthOverrideContext
  ) => Promise<ProviderRuntimeAuthOverrideResult | null | undefined>;
};
```

SDK registration:

```ts
api.registerProviderRuntimeAuthOverride({
  providers: ["anthropic", "openai", "openrouter"],
  priority: 0,
  run: async (ctx) => {
    const token = await getCurrentVaultBearerTokenForProvider(ctx.provider);
    if (!token) return null;
    return {
      apiKey: token.value,
      expiresAt: token.expiresAt,
      source: "agenthifive:vault-runtime-auth",
    };
  },
});
```

### Runtime integration point

The integration point should be in the same phase where OpenClaw currently:
- resolves raw configured auth for a provider
- optionally applies provider-owned runtime auth preparation
- stores runtime auth for the inference request

The desired order is:

1. OpenClaw resolves the normal configured credential
2. OpenClaw asks registered runtime-auth override plugins whether they want to replace/exchange it
3. If no override applies, existing behavior continues
4. If an override applies, that runtime credential is used
5. Built-in provider behavior otherwise remains unchanged

---

## 5. Why This Is Better Than Turning AgentHiFive Into the Provider

AgentHiFive could also avoid the patch by becoming a full provider plugin for:
- Anthropic
- OpenAI
- OpenRouter

That is viable, because OpenClaw already exposes provider-plugin hooks such as `prepareRuntimeAuth`.

But that path has a higher maintenance cost because AgentHiFive would then own more of the provider surface:
- catalog curation
- capability metadata
- compatibility quirks
- long-term alignment with OpenClaw's built-in provider behavior

By contrast, the narrow runtime-auth override hook preserves the best division of responsibility:

### OpenClaw continues to own
- built-in provider ids
- provider quirks and compatibility logic
- model metadata behavior
- transport defaults
- usage behavior
- ongoing provider evolution

### AgentHiFive owns only
- vault token exchange
- short-lived credential rotation
- policy and governance around model access

This is the cleanest long-term split if OpenClaw is willing to expose the hook.

---

## 6. Backwards Compatibility

This proposal should be fully backwards compatible.

If no plugin registers a runtime-auth override:
- existing provider auth behavior remains unchanged

If overrides are registered but return `null`:
- existing provider auth behavior remains unchanged

This is important for upstream review because the change is additive and low-risk.

---

## 7. What This Replaces

### Replaces
- AgentHiFive `model-auth` patch for vault-managed LLM proxying

### Does not replace
- normal plugin hooks
- channel plugin entrypoints
- built-in provider plugins
- provider-owned `prepareRuntimeAuth`

This proposal is intentionally narrow.

---

## 8. Why We Are Not Asking For More

We should explicitly avoid asking OpenClaw for things we no longer need.

### Not requested in this PR

- no channel credential-provider abstraction
- no plugin broadcast API changes
- no gateway lifecycle hook redesign
- no new generalized external secret-manager framework
- no changes to `before_agent_start`

Those either:
- already work today
- are no longer needed
- or are product polish rather than launch blockers

That makes the upstream ask easier to review and more likely to land.

---

## 9. MVP Story If The PR Does Not Land Quickly

AgentHiFive still has a credible MVP without this PR.

### MVP path A
- ship current architecture
- keep the model-auth patch for short-lived rotating tokens

### MVP path B
- avoid the patch by using a longer-lived vault token for LLM proxy auth
- accept that this is less elegant than the rotating-token design

So this PR is not required to prove the product.
It is the path to the cleanest long-term architecture.

---

## 10. Optional Follow-Up PRs

If OpenClaw is receptive, there are a couple of possible follow-ups. These should be framed as optional, not bundled into the first ask.

### Follow-up A: usage-auth override for built-in providers

OpenClaw already has provider-owned `resolveUsageAuth`.

If AgentHiFive also wants to mediate usage endpoints for built-in providers without becoming the provider, a similar external override could be useful:
- same spirit as runtime-auth override
- for `/usage` and related surfaces

This is useful, but not necessary for the first PR.

### Follow-up B: cleaner modern prompt/context hooks

AgentHiFive still uses public hooks such as `before_agent_start`. That works today.

If OpenClaw wants to encourage newer patterns, future hook surfaces such as:
- `before_model_resolve`
- `before_prompt_build`

could be emphasized more clearly in docs or API recommendations.

Again, not required for the auth PR.

---

## 11. Suggested Upstream Pitch

### Problem

OpenClaw already supports provider-owned runtime auth exchange for provider plugins, but there is no public way for an external plugin to apply the same pattern to an existing built-in provider.

This makes it hard to integrate enterprise vaults and policy brokers that want to:
- keep built-in provider behavior
- but replace static provider secrets with short-lived runtime credentials

### Proposed solution

Add an additive plugin API that lets external plugins override or exchange runtime auth for specific built-in providers just before inference.

### Benefits

- no breaking changes
- keeps built-in provider behavior intact
- enables vault/secret-broker integrations without forks
- uses an architectural pattern OpenClaw already understands through `prepareRuntimeAuth`

### Why this is better than a broader secret-manager framework

It solves a concrete real problem with a small review surface.

It is easier to reason about than a general `CredentialProvider` system because it touches only:
- model runtime auth
- only at inference time
- only when a plugin explicitly opts in

---

## 12. AgentHiFive Migration If The PR Lands

If this hook is accepted:

1. Keep current channel-plugin architecture unchanged
2. Remove the `model-auth` patch
3. Register a runtime-auth override for:
   - `anthropic`
   - `openai`
   - `openrouter`
4. Continue using `channels.agenthifive` as the canonical integration config
5. Keep OpenClaw built-in providers and their model behavior

That gives AgentHiFive a strong long-term story:
- no core patch
- no fake channel plumbing
- no provider-family reimplementation

---

## 13. Open Questions

1. Should the override run before or after provider-owned `prepareRuntimeAuth`?
   - Recommendation: before provider-owned exchange for built-ins, or as a dedicated step that feeds the credential into the existing pipeline.

2. Should multiple plugins be allowed to register overrides for the same provider?
   - Recommendation: yes, with priority ordering and first non-null win.

3. Should the result be allowed to override `baseUrl`?
   - Recommendation: yes. This is important for brokered proxy endpoints and parity with existing `prepareRuntimeAuth`.

4. Should the result carry expiry?
   - Recommendation: yes. This enables generic refresh semantics in long-running turns.

5. Should there also be a usage-auth analogue in the same PR?
   - Recommendation: no. Keep the first PR narrow.

---

## 14. Bottom Line

The original upstream plan was broader than necessary.

Now that channels are solved in plugin space, the clean upstream ask is:

**Add a public runtime-auth override hook for built-in model providers.**

That is the one change that would let AgentHiFive:
- keep short-lived rotating vault tokens
- avoid patching OpenClaw core
- keep using OpenClaw's built-in provider ecosystem
- avoid reimplementing provider families just to own auth exchange
