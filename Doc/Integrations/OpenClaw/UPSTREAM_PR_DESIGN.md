# OpenClaw Upstream PR Design: Runtime Provider Auth Override

> **Purpose**: Rewrite of the OpenClaw upstream PR proposal after the channel-plugin migration. The remaining upstream ask is no longer a general credential framework. The concrete gap is a public way for an external plugin to override runtime auth for built-in model providers, so AgentHiFive can stop patching OpenClaw core.
>
> **Date**: 2026-04-11
>
> **Prerequisites**:
> - [CREDENTIAL_ARCHITECTURE_ANALYSIS.md](./CREDENTIAL_ARCHITECTURE_ANALYSIS.md)
> - [OPENCLAW_TECHNICAL_INTEGRATION.md](./OPENCLAW_TECHNICAL_INTEGRATION.md)
>
> **Status**: Revised draft

---

## 1. Executive Summary

The original upstream pitch was too broad.

We no longer need OpenClaw changes for channel support:
- Telegram and Slack work as native channel plugins
- `before_agent_start` is already public plugin API
- approvals and follow-up lifecycle behavior can stay in plugin space

The one remaining place where AgentHiFive still patches OpenClaw is **LLM runtime auth**.

Today AgentHiFive patches OpenClaw so that when a built-in provider such as `anthropic`, `openai`, or `openrouter` is vault-managed, OpenClaw uses the current vault-issued runtime credential instead of the static configured key. It also patches request-header injection so the outbound provider request carries AgentHiFive routing headers such as session and approval identifiers.

That works, but it is still a core patch.

It also relies on an implicit mutable bridge through `globalThis.__ah5_runtime` so plugin-owned state can be read from patched core code. A public override API removes not only the patch, but also that undocumented side channel between plugin code and OpenClaw internals.

### New upstream ask

Add a small public registration API for **runtime auth override of built-in providers**.

The API should let an external plugin say:
- for this built-in provider
- and this selected model
- use this runtime auth instead of the default resolved auth
- optionally override the provider base URL
- optionally attach extra provider request headers

This keeps the right division of responsibility:
- OpenClaw still owns built-in provider behavior
- OpenClaw still owns provider quirks, transport, and catalog evolution
- AgentHiFive only owns the runtime auth exchange and broker-specific headers

### Why this shape

This is intentionally narrower than the old `CredentialProvider` proposal:
- no channel credential abstraction
- no broadcast ask
- no generic secret-manager framework
- no gateway lifecycle redesign

It also avoids the two extremes:
- too small to replace only patch 1 and leave patch 2 behind
- too broad to look like a generic request-mutation framework

The right middle ground is:
- a narrow auth-override registration API
- plus `providerRequestHeaders` in the result so the same PR can replace both existing local model-auth patches

---

## 2. What Is Already Solved

### Channels do not need an upstream PR

AgentHiFive can integrate Telegram and Slack through OpenClaw's channel-plugin SDK:
- native channel plugin entry
- native inbound and outbound runtime
- approval-aware outbound actions
- no fake-channel prompt ingress

So we should not ask OpenClaw for channel APIs in this PR.

### `before_agent_start` is not a patch

AgentHiFive still uses `before_agent_start`, but that hook is already public API.

That is not an upstream blocker.

### OpenClaw already supports provider-owned runtime auth

OpenClaw already has provider-side concepts such as:
- `prepareRuntimeAuth`
- `resolveUsageAuth`

So the missing capability is not "support runtime auth exchange at all."

The missing capability is:

**let an external plugin do that for an existing built-in provider without replacing that provider entirely.**

---

## 3. Current Problem

AgentHiFive wants to keep using OpenClaw's built-in providers:
- `anthropic`
- `openai`
- `openrouter`

That is desirable because OpenClaw already owns:
- provider-specific capability hints
- model-family quirks
- reasoning and transport behavior
- usage behavior
- catalog evolution

At runtime, however, AgentHiFive does not want OpenClaw to use a static provider API key from config. It wants OpenClaw to use the current brokered runtime credential.

Today we accomplish that with two local patches in `model-auth.ts`:

### Patch 1: runtime auth replacement

If the provider is proxied and AgentHiFive has a current vault bearer token, OpenClaw uses that token as the resolved runtime auth.

### Patch 2: provider request headers

If the runtime auth came from AgentHiFive's vault path, OpenClaw injects broker-specific request headers such as:
- `x-ah5-session-key`
- `x-ah5-approval-id`

Patch 1 and patch 2 are both part of the real integration. Replacing only patch 1 would still leave AgentHiFive carrying a local patch.

---

## 4. Recommended Upstream PR

### Proposal

Add a public registration API:

- `registerProviderRuntimeAuthOverride`

This should allow regular plugins to override runtime auth for specific built-in providers without replacing the provider implementation.

### Minimal API shape

```ts
export type ProviderRuntimeAuthOverrideContext = {
  provider: string;
  modelId: string;
  profileId?: string;
};

export type ProviderRuntimeAuthOverrideResult = {
  apiKey: string;
  mode?: string;
  source?: string;
  baseUrl?: string;
  providerRequestHeaders?: Record<string, string>;
};

export type ProviderRuntimeAuthOverride = {
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
  run: async (ctx) => {
    const token = await getCurrentVaultBearerTokenForProvider(ctx.provider);
    if (!token) return null;

    return {
      apiKey: token.value,
      mode: "api-key",
      source: "agenthifive:vault-runtime-auth",
      baseUrl: token.baseUrl,
      providerRequestHeaders: {
        "x-ah5-session-key": getCurrentSessionKey(),
        "x-ah5-approval-id": getApprovedLlmApprovalId(),
      },
    };
  },
});
```

### Why this exact surface

#### Keep

- `provider`
- `modelId`
- `profileId?`

That is enough context for AgentHiFive's use case and is easy for OpenClaw to document and keep stable.

#### Keep

- `baseUrl`

This is a small addition, but it keeps the API useful for brokered or proxied provider endpoints.

The returned `baseUrl` should apply only to the single inference call being built. It should not mutate provider configuration or reconfigure the provider instance globally.

#### Keep

- `providerRequestHeaders`

This is the one non-negotiable addition beyond basic auth override if this PR is expected to replace both existing local patches. Without it, AgentHiFive still needs a second local patch or a second upstream ask.

#### Cut

- `config`
- `agentDir`
- `workspaceDir`
- `env`
- `model: ProviderRuntimeModel`
- `priority`
- `expiresAt`
- `resolvedAuth.apiKey`

These are all extra surface for v1 and create avoidable review risk.

In particular:
- `resolvedAuth.apiKey` raises an obvious "why is one plugin receiving another provider's secret?" question
- `priority` is unnecessary if registration order plus first non-null win is the rule
- `expiresAt` should not be exposed unless OpenClaw is actually going to consume it

### Notes on `mode` and `source`

These should be explicitly described as optional metadata on the returned runtime auth, not as a second configuration surface.

Recommendation:
- `mode` is an opaque string carried with resolved auth for existing OpenClaw auth bookkeeping and logging
- `source` is an opaque string for attribution, logging, and debugging

This proposal does not require OpenClaw to interpret arbitrary new `mode` values. For AgentHiFive's use case, the returned value remains `mode: "api-key"`.

---

## 5. Runtime Semantics

The intended flow is:

1. OpenClaw resolves provider and model normally.
2. OpenClaw resolves the normal auth for that provider.
3. OpenClaw runs registered runtime auth overrides for that provider.
4. The first override that returns a non-null result wins.
5. OpenClaw uses that returned auth, base URL, and request headers when building the outbound provider request.
6. If no override applies, existing behavior continues unchanged.

### Explicit contract

- The callback runs only for exact built-in provider ids listed in `providers`.
- Unknown provider ids in the registration list are ignored silently.
- `null` or `undefined` means "no override, continue default behavior."
- Throwing or rejecting means "override failed, fail the request after logging."
- There should be no implicit fallback after a thrown error.
- If a plugin wants fallback behavior, it should catch internally and return `null`.
- The callback is asynchronous and may perform network I/O such as token exchange or refresh.
- OpenClaw may enforce a reasonable timeout for override execution so a hung plugin does not stall an inference request indefinitely.

### Error shape

Recommendation:
- OpenClaw should surface a structured runtime-auth-override failure that includes the provider id and the plugin or override registration identity when available
- the agent-facing error can still be rendered as a normal inference failure, but the underlying message should make it clear the failure happened in runtime auth override rather than in provider transport

This matters because the proposal intentionally changes behavior from silent fallback on internal override failure to explicit request failure.

### Multiple registrations

Recommendation:
- allow multiple registrations
- use registration order
- first non-null result wins

This is simpler than exposing a public `priority` mechanism in v1.

### Provider wildcard

Recommendation:
- wildcard provider matching is out of scope for v1
- plugins should register the exact built-in providers they want to override
- when OpenClaw adds a new built-in provider, a plugin can opt in explicitly by updating its registration list

This keeps the first version easier to reason about and avoids hidden behavior changes when new providers are introduced upstream.

---

## 6. Why Not A Generic Hook

A generic request-mutation hook could also solve this problem.

That is true, and the proposal should say so plainly.

The reason to prefer a dedicated registration API here is not that a generic hook is impossible. The reason is that a dedicated API:
- communicates narrower scope
- is easier to document
- is easier to constrain
- is easier to review as an additive change

That matters because the review risk is not auth replacement by itself. The review risk is letting the PR feel like a broad request-mutation surface.

This proposal avoids that by keeping the scope tightly named and tightly typed:
- runtime auth override for built-in providers
- plus narrowly scoped provider request headers needed to complete the auth path

---

## 7. Why This Is Better Than Turning AgentHiFive Into The Provider

AgentHiFive could avoid the patch by becoming a full provider plugin for:
- Anthropic
- OpenAI
- OpenRouter

That is technically viable, but it moves too much ownership into AgentHiFive:
- catalog curation
- compatibility quirks
- provider metadata behavior
- long-term alignment with OpenClaw's built-in providers

The narrow runtime-auth override API preserves the cleaner split:

### OpenClaw owns

- built-in provider ids
- provider quirks and compatibility logic
- model metadata behavior
- transport defaults
- usage behavior
- ongoing provider evolution

### AgentHiFive owns

- runtime token exchange
- short-lived credential rotation
- broker-specific routing and approval headers
- policy and governance around model access

---

## 8. Backwards Compatibility

This proposal is additive and should be fully backwards compatible.

If no plugin registers an override:
- existing provider auth behavior remains unchanged

If an override is registered but returns `null`:
- existing provider auth behavior remains unchanged

Only a plugin that explicitly opts in changes behavior for a provider.

Once shipped, this API surface should be considered stable and follow OpenClaw's normal deprecation policy.

### Testing expectations

The PR should include Vitest tests alongside the existing runtime auth test suite (e.g., `src/secrets/runtime.test.ts`). Recommended coverage:

- override applied: registered override returns auth, provider uses it
- override returns null: default auth behavior unchanged
- override throws: request fails with structured error (not silent fallback)
- multiple registrations: first non-null result wins, registration order respected
- unknown provider id in registration: ignored silently, no error
- `baseUrl` override: applied to single inference call only
- `providerRequestHeaders`: merged into outbound provider request

---

## 9. What This Replaces

### Replaces

- AgentHiFive patch 1: runtime auth replacement for proxied built-in providers
- AgentHiFive patch 2: provider request-header injection for vault-managed model calls

### Does not replace

- channel plugin entrypoints
- provider-owned `prepareRuntimeAuth`
- provider-owned `resolveUsageAuth`
- broadcast bridge work
- general plugin hooks such as `before_agent_start`

This proposal is intentionally narrow.

---

## 10. What We Are Not Asking For

This PR should explicitly avoid asking OpenClaw for things we no longer need.

### Not requested in this PR

- no channel credential-provider abstraction
- no plugin broadcast API changes
- no gateway lifecycle redesign
- no generalized external secret-manager framework
- no usage-auth analogue in the same PR
- no changes to `before_agent_start`

That keeps the ask easier to review and more likely to land.

---

## 11. Suggested Upstream Pitch

### Problem

OpenClaw already supports provider-owned runtime auth exchange for provider plugins, but there is no public way for an external plugin to apply the same pattern to an existing built-in provider.

That makes it hard to integrate enterprise vaults and policy brokers that want to:
- keep built-in provider behavior
- replace static provider secrets with short-lived runtime credentials
- attach narrow broker-specific request headers at the final provider call boundary

### Proposed solution

Add an additive plugin API that lets external plugins override runtime auth for specific built-in providers just before inference.

The returned override may supply:
- `apiKey`
- optional `mode`
- optional `source`
- optional `baseUrl`
- optional `providerRequestHeaders`

### Benefits

- no breaking changes
- keeps built-in provider behavior intact
- removes the need for local model-auth patches
- enables vault and broker integrations without asking plugins to reimplement provider families
- removes the need for an undocumented `globalThis` bridge between plugin code and patched core code

### Why not a broader secret-manager framework

Because the narrower API solves the concrete problem with a much smaller review surface.

---

## 12. AgentHiFive Migration If The PR Lands

If this hook is accepted:

1. Keep current channel-plugin architecture unchanged.
2. Remove the local model-auth patches.
3. Register a runtime auth override for:
   - `anthropic`
   - `openai`
   - `openrouter`
4. Continue using OpenClaw built-in providers for provider behavior.

That gives AgentHiFive the desired long-term state:
- no core patch for model auth
- no fake channel plumbing
- no provider-family reimplementation

---

## 13. If The PR Does Not Land

AgentHiFive still has a fallback path if this upstream change is rejected or delayed:
- the existing local patches continue to work
- the current integration can keep shipping on top of those patches

That means this proposal is a cleanup and stability improvement, not a launch blocker.

---

## 14. Bottom Line

The original upstream plan was broader than necessary.

Now that channels are solved in plugin space, the clean one-PR ask is:

**Add a public runtime auth override registration API for built-in model providers, with optional `baseUrl` and `providerRequestHeaders`.**

That is the smallest proposal that still replaces both existing AgentHiFive model-auth patches in one shot.
