---
title: Setup CLI Reference
sidebar_position: 5
sidebar_label: Setup CLI Reference
description: Full reference for the @agenthifive/openclaw-setup CLI — interactive setup, reconnect, sync, verify, and troubleshooting.
---

# Setup CLI Reference

The `@agenthifive/openclaw-setup` package provides a CLI wizard for connecting OpenClaw to AgentHiFive. It handles agent registration, key pair generation, connection syncing, plugin installation, and patching.

## Installation

The setup CLI is published as a standalone npm package:

```bash
npx @agenthifive/openclaw-setup
```

Or install globally:

```bash
npm install -g @agenthifive/openclaw-setup
ah5-setup
```

Current version: **0.2.17**

## Interactive Mode (Default)

Running without flags presents an interactive menu:

```bash
npx @agenthifive/openclaw-setup
```

**Menu options:**

| Option | Description |
|--------|-------------|
| **Connect to vault** | First-time setup — register agent, fetch connections, install plugin, apply patches |
| **Change default LLM** | Re-pick the default LLM model while keeping existing connections |
| **Reconnect to vault** | Re-authenticate with a new bootstrap secret (e.g., after key rotation) |
| **Sync connections** | Re-fetch vault connections and update OpenClaw config |
| **Verify installation** | Check that patches, config, and authentication are working (no changes made) |
| **Remove AgentHiFive** | Cleanly remove the plugin, patches, and configuration |

## CLI Options

```
npx @agenthifive/openclaw-setup [options]
```

| Flag | Description |
|------|-------------|
| `--base-url <url>` | AgentHiFive API base URL (default: `https://app.agenthifive.com`) |
| `--bootstrap-secret <secret>` | Enrolment key from the dashboard (`ah5b_...`) |
| `--default-model <model>` | Default LLM model (e.g., `anthropic/claude-sonnet-4-6`) |
| `--config-path <path>` | Explicit OpenClaw config file path |
| `--openclaw-dir <path>` | Explicit OpenClaw installation directory |
| `--mode <mode>` | Run a specific mode: `setup`, `change-model`, `reconnect`, `sync`, `verify`, `remove` |
| `--non-interactive` | Run without prompts (requires `--base-url` and `--bootstrap-secret`) |
| `--skip-onboard` | Skip the OpenClaw onboard step |
| `--skip-plugin-install` | Skip plugin installation (useful when deploying from tarball) |
| `--sync` | Shorthand for `--mode sync` |
| `--verify` | Shorthand for `--mode verify` |
| `-h`, `--help` | Show help message |

## What the Setup Does

The first-time setup performs these steps in order:

1. **Check OpenClaw installation** — validates that `openclaw --version` works
2. **Prompt for base URL** — the AgentHiFive API endpoint (SaaS or self-hosted)
3. **Bootstrap agent** — uses the enrolment key to authenticate and register an ES256 key pair
4. **Fetch vault connections** — retrieves available integrations (LLM providers, messaging, productivity)
5. **Choose default LLM** — interactive model selection from connected LLM providers
6. **Configure channels** — enables vault-managed Telegram and Slack channels if available
7. **Run OpenClaw onboard** — initializes OpenClaw with the agent configuration
8. **Install plugin** — runs `openclaw plugins install @agenthifive/agenthifive`
9. **Write configuration** — merges plugin config into `~/.openclaw/openclaw.json`
10. **Apply patches** — injects vault integration into OpenClaw's runtime
11. **Verify** — checks that everything is configured correctly

## Config File Location

The setup wizard writes to the standard OpenClaw config path:

```
~/.openclaw/openclaw.json
```

It looks for existing config in this priority order:
1. `$OPENCLAW_CONFIG_PATH` or `$CLAWDBOT_CONFIG_PATH` environment variable
2. `$OPENCLAW_STATE_DIR/openclaw.json`
3. `~/.openclaw/openclaw.json` (preferred default)

## Common Workflows

### First-time setup (interactive)

```bash
npx @agenthifive/openclaw-setup
# Select "Connect to vault"
# Enter base URL and enrolment key when prompted
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
npx @agenthifive/openclaw-setup --mode reconnect \
  --base-url https://app.agenthifive.com \
  --bootstrap-secret ah5b_NEW_SECRET
```

### Re-sync connections (manual)

Connections are synced automatically during setup. If you need to manually re-sync after making changes in the dashboard:

```bash
npx @agenthifive/openclaw-setup --sync
```

### Verify installation

Check that everything is working without making changes:

```bash
npx @agenthifive/openclaw-setup --verify
```

## Troubleshooting

### "Token exchange rejected — clock out of sync"

The agent's JWT assertion has a timestamp that the server considers too far from its own clock. Sync the system clock:

```bash
# Linux
sudo timedatectl set-ntp true

# macOS
sudo sntp -sS time.apple.com
```

### "Token exchange rejected (401) — key pair no longer valid"

The agent's ES256 key has been rotated or the agent was disabled. Generate a new enrolment key from the dashboard and reconnect:

```bash
npx @agenthifive/openclaw-setup --mode reconnect \
  --bootstrap-secret ah5b_NEW_KEY
```

### "Patch verification failed"

The OpenClaw installation was updated and patches need to be reapplied:

```bash
npx @agenthifive/openclaw-setup --mode setup --skip-plugin-install
```

### Setup can't find OpenClaw

Specify the installation directory explicitly:

```bash
npx @agenthifive/openclaw-setup --openclaw-dir /path/to/openclaw
```
