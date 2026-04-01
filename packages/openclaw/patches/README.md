# AgentHiFive OpenClaw Patches

Optional patches that enable LLM credential proxying in OpenClaw core.

**These patches are NOT required for basic functionality.** The AgentHiFive plugin
works fully without patches — tools, prompt injection, approval flow, and the
brokered API proxy (Model B) all work out of the box. Patches only enable
**LLM credential proxying** (routing LLM API calls through the vault).

## How It Works

The patch injects a small code block into `resolveApiKeyForProvider()` that checks
`globalThis.__ah5_runtime` (set by the plugin at startup). When the requested
provider is in the `proxiedProviders` list, it returns the vault bearer token
instead of looking up a local API key. Combined with the provider `baseUrl`
redirect (set in `openclaw.json` by the setup wizard), this routes all LLM
traffic through the vault's Model B proxy.

## Available Patches

### `model-auth.patch`

Adds vault credential resolution to `src/agents/model-auth.ts`:

| Tier | What it does | When it activates |
|------|-------------|-------------------|
| **Tier 0** | Returns the vault bearer token | Provider is in `proxiedProviders` list |

The patch uses `globalThis.__ah5_runtime` (no dynamic imports), so it's a
**complete no-op** when the plugin is not installed.

## How to Apply

### Automatic (recommended)

```bash
npx @agenthifive/openclaw-setup --base-url https://app.agenthifive.com --bootstrap-secret ah5b_...
```

The setup wizard applies the patch automatically as step 7/7.

### Manual with pnpm patch

```bash
pnpm patch openclaw
cd <temp-directory>
patch -p1 < /path/to/@agenthifive/openclaw/patches/model-auth.patch
pnpm patch-commit <temp-directory>
```

## Verification

After applying, the AgentHiFive plugin will log at startup:

```
AgentHiFive: model-auth patch detected — credential proxying enabled
```

Without the patch:

```
AgentHiFive: model-auth patch not detected. LLM credential proxying is unavailable.
```

## When Patches Become Unnecessary

When OpenClaw merges support for `apiKeyOverride` in the `before_model_resolve`
hook result type, the plugin can use the hook API directly and patches will be
deprecated.
