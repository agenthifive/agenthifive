---
title: Setup CLI Reference
sidebar_position: 5
sidebar_label: Setup CLI Reference
description: Full reference for the @agenthifive/openclaw-setup CLI — interactive setup, reconnect, sync, verify, remove, and troubleshooting.
---

# Setup CLI Reference

The `@agenthifive/openclaw-setup` package (v0.2.18) is a standalone CLI that connects an [OpenClaw](https://openclaw.dev) installation to the AgentHiFive vault. It handles agent registration, ES256 key pair generation, LLM proxy configuration, plugin installation, runtime patching, channel setup, and diagnostics.

The binary name is **`ah5-setup`**.

## Installation

Run directly with npx (no install required):

```bash
npx @agenthifive/openclaw-setup
```

Or install globally for the `ah5-setup` command:

```bash
npm install -g @agenthifive/openclaw-setup
ah5-setup
```

## Interactive Menu

Running without flags presents an interactive menu:

```bash
ah5-setup
```

| # | Menu Option | Mode | Description |
|---|-------------|------|-------------|
| 1 | First connection to vault | `setup` | Full install: plugin + auth + config + patch |
| 2 | Configure vault connections | `configure-connections` | Change default LLM, connect or remove channels |
| 3 | Reconnect to vault | `reconnect` | New bootstrap secret, re-auth, update config + re-patch |
| 4 | Verify installation | `verify` | Check everything is working (no changes made) |
| 5 | Remove AgentHiFive | `remove` | Remove channel config + uninstall plugin |

## CLI Modes

All modes can be invoked with `--mode <name>` or, for some, with dedicated shorthand flags.

### `setup` (default)

First-time installation. Registers the agent with the vault, installs the plugin, writes configuration, and patches OpenClaw's runtime. This is the default mode when `--base-url` or `--bootstrap-secret` is provided without an explicit `--mode`.

```bash
ah5-setup --base-url https://app.agenthifive.com --bootstrap-secret ah5b_...
```

### `configure-connections`

Interactive menu for toggling channel providers (Slack, Telegram) on or off, and changing the default LLM model. Requires an existing setup (reads auth from config). Does not support `--non-interactive`.

```bash
ah5-setup --mode configure-connections
```

### `change-model`

Re-pick the default LLM model using the existing agent auth. Fetches current vault capabilities, presents an interactive provider and model picker, and updates `agents.defaults.model` in the config.

```bash
ah5-setup --mode change-model
```

### `reconnect`

Re-authenticate with a new bootstrap secret. Generates a fresh ES256 key pair, re-bootstraps with the vault, fetches capabilities, rebuilds configuration, and re-applies patches. Use this after key rotation or when the agent's key pair is no longer valid.

```bash
ah5-setup --mode reconnect --bootstrap-secret ah5b_NEW_SECRET
```

### `sync`

Re-fetch vault connections and update the local OpenClaw config. Uses existing auth credentials (no new bootstrap secret needed). Preserves the current default model. Also available via the `--sync` shorthand flag.

```bash
ah5-setup --sync
# equivalent to:
ah5-setup --mode sync
```

### `verify`

Run diagnostic checks against the installation without making any changes. Also available via the `--verify` shorthand flag. Returns exit code 0 if all checks pass, 1 otherwise.

```bash
ah5-setup --verify
ah5-setup --verify --openclaw-dir /path/to/openclaw
```

### `remove`

Cleanly remove AgentHiFive. Deletes the `channels.agenthifive` block from the OpenClaw config file, then runs `openclaw plugins uninstall agenthifive --force`.

```bash
ah5-setup --mode remove
```

## CLI Flags

| Flag | Description |
|------|-------------|
| `--base-url <url>` | AgentHiFive API base URL. Prompted interactively if not provided; defaults to `https://app.agenthifive.com`. |
| `--bootstrap-secret <secret>` | Enrolment key from the dashboard (`ah5b_...`). Required for `setup` and `reconnect` in non-interactive mode. |
| `--default-model <model>` | Default LLM model identifier (e.g., `anthropic/claude-sonnet-4-6`). Skips the interactive model picker. |
| `--mode <mode>` | Explicit mode: `setup`, `configure-connections`, `change-model`, `reconnect`, `sync`, `verify`, `remove`. |
| `--config-path <path>` | Explicit path to the OpenClaw config file (overrides auto-discovery). |
| `--openclaw-dir <path>` | Explicit path to the OpenClaw installation directory (overrides auto-detection). |
| `--non-interactive` | Run without prompts. Requires `--base-url` and `--bootstrap-secret` for setup/reconnect. |
| `--skip-onboard` | Skip the OpenClaw onboard step during first-time setup. |
| `--skip-plugin-install` | Skip the `openclaw plugins install` step (useful when deploying from a tarball or pre-installed image). |
| `--sync` | Shorthand for `--mode sync`. |
| `--verify` | Shorthand for `--mode verify`. |
| `-h`, `--help` | Show the built-in help message and exit. |

## Setup Flow (Step by Step)

When running first-time setup (`setup` mode), the CLI performs these steps in order:

### Step 1 -- Check OpenClaw installation

Runs `openclaw --version` to confirm OpenClaw is installed and on the PATH. Exits with an error if not found.

### Step 2 -- OpenClaw onboard

If OpenClaw has not been set up yet (no config file or state directory exists), runs the onboard command automatically:

```
openclaw onboard --non-interactive --accept-risk --auth-choice skip \
  --install-daemon --skip-channels --skip-skills --skip-search --skip-health --skip-ui
```

Skipped if `--skip-onboard` is passed or OpenClaw is already onboarded.

### Step 3 -- Install plugin

Runs `openclaw plugins install @agenthifive/agenthifive` if the plugin is not already present in `~/.openclaw/extensions/`. Restarts the gateway afterwards. Skipped if `--skip-plugin-install` is passed.

### Step 4 -- Bootstrap agent

1. Prompts for the base URL (or uses `--base-url`). Performs a health check against `/v1/health`.
2. Displays a summary of any existing OpenClaw config (providers, channels, plugins).
3. Prompts for the bootstrap secret (or uses `--bootstrap-secret`). Must start with `ah5b_`.
4. Generates an ES256 key pair using the `jose` library.
5. Sends `POST /v1/agents/bootstrap` with the public JWK and the bootstrap secret.
6. Verifies the returned credentials by performing a token exchange via `VaultTokenManager`.

### Step 5 -- Fetch capabilities and configure

1. Calls `GET /v1/capabilities/me` with the agent bearer token.
2. Classifies returned connections into LLM providers (proxied), channel services (Slack, Telegram), and other connected providers.
3. If there are local API keys for providers that the vault now manages, offers to remove them (replaces with `"vault-managed"`).
4. Presents an interactive LLM provider and model picker. Uses `openclaw models list --all --provider <name> --json` to fetch the full model catalog when available, falling back to built-in defaults (Anthropic, OpenAI, Gemini, OpenRouter).
5. Offers to enable available channel services (Telegram, Slack). For channels that already have local credentials, offers to migrate them to vault-managed.

### Step 6 -- Write configuration

Builds a config block and deep-merges it into the existing `openclaw.json`. The merge:

- Sets `plugins.enabled = true` and adds `"agenthifive"` to `plugins.allow`.
- Writes `channels.agenthifive.accounts.default` with vault URL, agent auth, and channel providers.
- Writes `plugins.entries.agenthifive` with vault auth and connected/proxied provider lists.
- Writes `models.providers.<name>` entries that redirect each LLM provider's `baseUrl` to the vault's brokered proxy endpoint (`/v1/vault/llm/<provider>`).
- Writes `agents.defaults.model` with the selected default model.
- Writes `tools.alsoAllow: ["group:plugins"]` so plugin tools are visible.
- Removes native channel entries (`plugins.entries.<channel>`, `channels.<channel>`) for services migrated to vault management.
- Backs up the existing config to `openclaw.json.bak` before overwriting.

### Step 7 -- Patch OpenClaw runtime

Applies two patches to OpenClaw's compiled JavaScript:

1. **Credential resolution patch** -- Injected into every dist chunk containing `resolveApiKeyForProvider()`. Adds vault credential resolution before local profile lookup:
   - **Tier 0 (proxied providers):** If the provider is vault-managed, returns the vault bearer token directly as the API key with source `"vault:agent-token"`.
   - **Header injection:** For requests authenticated via vault token, injects `x-ah5-session-key` and `x-ah5-approval-id` headers for session tracking and approval replay.

2. **Broadcast bridge patch** -- Injected into gateway chunks containing the broadcast definition. Exposes the gateway's `broadcast` function on `globalThis.__ah5_runtime` so the plugin's approval watcher can push events to the TUI without HTTP hooks.

Both patches:
- Are idempotent (detected via version markers like `@ah5-patch-v5`).
- Create `.bak` backup files of the original chunks before modification.
- Automatically upgrade from older patch versions (restores backup, re-patches).
- Support both `dist` (compiled JS) and `source` (TypeScript) OpenClaw installations.

## What Setup Modifies

| Location | What changes |
|----------|-------------|
| OpenClaw `dist/*.js` chunks | Patched with vault credential resolution and broadcast bridge code. Backups saved as `*.js.bak`. |
| `~/.openclaw/openclaw.json` | `models.providers` (LLM proxy baseUrls), `channels.agenthifive` (vault auth + channel providers), `plugins.entries.agenthifive` (plugin config), `agents.defaults` (default model), `tools.alsoAllow`. |
| `~/.openclaw/extensions/` | AgentHiFive plugin installed via `openclaw plugins install`. |
| Local API key entries | For vault-managed providers, `apiKey` is replaced with `"vault-managed"` (original keys removed). |

## Config File Discovery

The setup CLI finds the OpenClaw config file in this priority order:

1. `--config-path` flag (explicit override)
2. `$OPENCLAW_CONFIG_PATH` or `$CLAWDBOT_CONFIG_PATH` environment variable
3. `$OPENCLAW_STATE_DIR/openclaw.json` (or legacy filenames)
4. `~/.openclaw/openclaw.json` (preferred default)
5. Legacy paths: `~/.openclaw/clawdbot.json`, `~/.clawdbot/`, `~/.moltbot/`, `~/.moldbot/`

If no config file exists, the default path `~/.openclaw/openclaw.json` is used for new installations.

## OpenClaw Installation Discovery

The CLI auto-detects the OpenClaw installation directory using a cascading strategy:

1. **PATH scan** -- Finds the `openclaw` binary on PATH, resolves symlinks, walks up to the package root.
2. **npm prefix** -- Derives the global `node_modules` path from the running Node.js binary location.
3. **Well-known paths** -- Checks platform-specific standard locations (`/usr/lib/node_modules/openclaw`, `/usr/local/lib/node_modules/openclaw`, Homebrew on macOS, AppData on Windows, pnpm global).
4. **Recursive scan** -- Last resort: scans `/usr`, `/opt`, and `$HOME` up to 8 levels deep.

If auto-detection fails, the CLI prompts interactively (or use `--openclaw-dir`).

## Verify Command

The `--verify` flag runs a comprehensive diagnostic without making changes. It checks seven categories:

### 1. OpenClaw Installation
- Locates the installation directory (or uses `--openclaw-dir`).
- Reports the OpenClaw version and install type (source or dist).

### 2. Patch Status
- Scans all dist chunks containing `resolveApiKeyForProvider`.
- Reports each chunk as patched (v5), old patch version, or not patched.
- Shows total/patched/unpatched counts.

### 3. Runtime Bridge
- Confirms the patch uses the `globalThis.__ah5_runtime` bridge (current approach).
- Flags the old `import()` approach if detected.
- Verifies the patch returns `vault:agent-token` for vault bearer token auth.

### 4. Broadcast Bridge
- Checks gateway chunks for the broadcast bridge patch (`@ah5-broadcast-v1`).
- Confirms the approval watcher can push events to the TUI.

### 5. Plugin
- Checks `~/.openclaw/extensions/` for the `agenthifive` or `@agenthifive` plugin directory.
- Reports plugin version.

### 6. Configuration
- Reads `openclaw.json` and checks:
  - `channels.agenthifive` channel entry (vault URL, auth mode, agent ID).
  - Connected providers and their enabled status.
  - LLM proxy `baseUrl` entries under `models.providers` (checks for `/v1/vault/llm/` pattern).
  - Legacy `plugins.entries.agenthifive` config (for older installations).

### 7. Vault Connectivity
- Sends a health check to the configured vault base URL (`/v1/health`).
- Reports success or connection failure.

### 8. Backups
- Lists `.js.bak` backup files in the OpenClaw `dist/` directory.

## Remove Command

The `remove` mode performs two actions:

1. **Remove channel config** -- Deletes `channels.agenthifive` from `openclaw.json`. If no other channels remain, removes the `channels` key entirely.
2. **Uninstall plugin** -- Runs `openclaw plugins uninstall agenthifive --force`.

Note: The remove command does not restore patched dist chunks. If you need to restore the original chunks, replace them from the `.bak` backup files in the OpenClaw `dist/` directory, or reinstall OpenClaw.

## Common Workflows

### First-time setup (interactive)

```bash
npx @agenthifive/openclaw-setup
# Select "First connection to vault"
# Enter base URL and bootstrap secret when prompted
```

### First-time setup (non-interactive / CI)

```bash
npx @agenthifive/openclaw-setup \
  --non-interactive \
  --base-url https://app.agenthifive.com \
  --bootstrap-secret ah5b_...
```

### Reconnect after key rotation

```bash
ah5-setup --mode reconnect --bootstrap-secret ah5b_NEW_SECRET
```

### Re-sync after dashboard changes

```bash
ah5-setup --sync
```

### Change default model

```bash
ah5-setup --mode change-model
```

### Verify installation

```bash
ah5-setup --verify
```

### Remove cleanly

```bash
ah5-setup --mode remove
```

## Troubleshooting

### "Token exchange rejected -- clock out of sync"

The agent's JWT assertion timestamp is too far from the server's clock. Sync the system clock:

```bash
# Linux
sudo timedatectl set-ntp true

# macOS
sudo sntp -sS time.apple.com
```

### "Token exchange rejected (401) -- key pair no longer valid"

The agent's ES256 key has been rotated or the agent was disabled in the dashboard. Generate a new bootstrap secret and reconnect:

```bash
ah5-setup --mode reconnect --bootstrap-secret ah5b_NEW_KEY
```

### "Patch verification failed" / old patch version

The OpenClaw installation was updated and patches need to be reapplied. Re-run setup with `--skip-plugin-install` to re-patch without reinstalling the plugin:

```bash
ah5-setup --mode setup --skip-plugin-install
```

### "Cannot reach vault"

The health check to `/v1/health` failed. Verify the URL is correct, the server is running, and there are no firewall or proxy issues. The health check has a 5-second timeout.

### Setup cannot find OpenClaw

Specify the installation directory explicitly:

```bash
ah5-setup --openclaw-dir /path/to/openclaw
```

### Permission denied during patching

The OpenClaw dist directory may be owned by root (global npm install). Run with elevated permissions:

```bash
sudo ah5-setup --openclaw-dir /usr/lib/node_modules/openclaw
```

### "No LLM connections found"

No LLM provider connections are configured for this agent in the vault. Add connections at the AgentHiFive dashboard, then re-sync:

```bash
ah5-setup --sync
```

### Changing models after setup

Use the OpenClaw TUI `/models` picker to switch models at any time -- this works fine with vault-managed providers. Avoid re-running `openclaw onboard` or `openclaw models auth` for vault-managed providers, because those flows expect local API keys.
