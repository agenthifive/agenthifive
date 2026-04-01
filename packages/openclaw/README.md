# @agenthifive/openclaw

OpenClaw plugin for [AgentHiFive](https://agenthifive.com) vault integration. Gives AI agents secure, policy-governed access to user accounts through vault-managed credentials and a brokered API proxy.

## What It Does

- **5 agent tools** for executing API calls through the vault (Model B brokered proxy)
- **Native channel plugins** for Telegram and Slack
- **Step-up approval flow** for sensitive actions (user approves via dashboard)
- **Prompt injection** with chunked API reference docs for connected services
- **ES256 JWT auth** with automatic background token refresh
- **Setup wizard** (`ah5-setup`) for bootstrapping agent auth

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install /path/to/agenthifive-agenthifive-0.4.5.tgz
```

### 2. Install the setup CLI

```bash
npm install -g /path/to/agenthifive-openclaw-setup-0.2.17.tgz
```

### 3. Run setup

Run the setup wizard to bootstrap agent auth, discover connected services, write config, and apply the credential proxying patch:

```bash
ah5-setup
```

Or non-interactively:

```bash
ah5-setup --base-url https://app.agenthifive.com --bootstrap-secret ah5b_...
```

The wizard automatically:
- Writes canonical AgentHiFive config to `~/.openclaw/openclaw.json`
- Applies the credential proxying patch to your OpenClaw installation

After setup:
- Changing models from the OpenClaw TUI `/models` picker is fine
- Avoid re-running OpenClaw `onboard` or `models auth` for vault-managed providers, because those flows expect local provider keys/tokens

Additional flags:
- `--config-path <path>` — explicit config file path
- `--openclaw-dir <path>` — explicit OpenClaw installation directory
- `--mode remove` — remove `channels.agenthifive` cleanly, then uninstall the plugin

### 4. Connect Services

Add OAuth connections (Google, Microsoft, Slack, Telegram, etc.) and configure policies in the [AgentHiFive dashboard](https://app.agenthifive.com).

## Tools

| Tool | Description |
|------|-------------|
| `agenthifive_execute` | Execute an HTTP request through the vault proxy (Model B) |
| `agenthifive_approval_request` | Create a step-up approval request for sensitive actions |
| `agenthifive_approval_commit` | Wait for an approval to be resolved |
| `agenthifive_connections_list` | List available connections and their status |
| `agenthifive_connection_revoke` | Revoke a connection immediately |

## Configuration

Canonical config lives under `channels.agenthifive` in your `openclaw.json`.

Minimal example:

```json
{
  "channels": {
    "agenthifive": {
      "accounts": {
        "default": {
          "enabled": true,
          "baseUrl": "https://app.agenthifive.com",
          "auth": {
            "mode": "agent",
            "agentId": "agent_...",
            "privateKey": "base64-encoded-jwk"
          },
          "providers": {
            "telegram": {
              "enabled": true,
              "dmPolicy": "balanced",
              "allowFrom": []
            },
            "slack": {
              "enabled": true
            }
          }
        }
      }
    }
  },
  "plugins": {
    "enabled": true,
    "allow": ["agenthifive"],
    "entries": {
      "agenthifive": {
        "enabled": true
      }
    }
  }
}
```

AgentHiFive's generic plugin layer derives its runtime config from that channel section, so `plugins.entries.agenthifive` remains intentionally minimal.

Important keys under `channels.agenthifive.accounts.<id>`:

| Key | Type | Description |
|-----|------|-------------|
| `baseUrl` | string | AgentHiFive API base URL |
| `auth.mode` | `"agent"` \| `"bearer"` | Authentication mode |
| `auth.agentId` | string | Agent ID (agent mode) |
| `auth.privateKey` | string | Base64-encoded ES256 JWK (agent mode) |
| `auth.token` | string | Bearer token (bearer mode) |
| `auth.tokenAudience` | string | Token audience override (optional) |
| `pollTimeoutMs` | number | Approval poll timeout (default: 300000) |
| `pollIntervalMs` | number | Approval poll interval (default: 3000) |
| `providers.telegram.*` | object | Telegram channel settings |
| `providers.slack.*` | object | Slack channel settings |

## LLM Credential Proxying

The setup wizard automatically patches OpenClaw's `resolveApiKeyForProvider()` to route LLM API calls through the vault, so agents don't need local API keys.

The patch is applied during `ah5-setup` and:
- Works with both npm installs (`dist/` chunks) and source installs (`src/`)
- Creates a `.bak` backup of the patched file
- Is idempotent (safe to run multiple times)
- Uses dynamic imports — no-op when the plugin is not installed

To re-apply manually (for example after an OpenClaw upgrade), re-run the setup wizard or see [`patches/README.md`](patches/README.md).

## Removing AgentHiFive

Use the setup CLI rather than uninstalling the plugin first:

```bash
ah5-setup --mode remove
```

That removes `channels.agenthifive` from config and then uninstalls the plugin cleanly.

## Programmatic Usage

The package also exports classes for use outside the plugin system:

```typescript
import { VaultClient, VaultTokenManager, VaultActionProxy } from "@agenthifive/openclaw";

// Direct API client
const client = new VaultClient({
  baseUrl: "https://app.agenthifive.com",
  auth: { mode: "bearer", token: "ah5t_..." },
});

// ES256 JWT token management
const tokenManager = new VaultTokenManager({
  baseUrl: "https://app.agenthifive.com",
  agentId: "agent_...",
  privateKey: jwk,
});
await tokenManager.init();
```

## License

MIT
