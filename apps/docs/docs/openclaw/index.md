---
title: OpenClaw Integration
sidebar_position: 1
sidebar_label: Overview
description: Route delegated access through AgentHiFive so provider tokens never live in OpenClaw — keeping agents safer on local, VPS, and sandboxed deployments.
---

# OpenClaw Integration

AgentHiFive integrates with [OpenClaw](https://github.com/anthropics/openclaw) to provide secure, auditable authority delegation for AI agents. Instead of storing OAuth refresh tokens or LLM API keys on the agent host, AgentHiFive acts as the credential boundary: the agent runtime never sees provider secrets, and every action is policy-checked and audit-logged.

## The problem today

OpenClaw agents store auth profiles and API keys locally. On VPS and remote gateway deployments this creates two issues:

- **UX friction** -- localhost OAuth callbacks require SSH tunnels or device-code workarounds.
- **Security risk** -- refresh tokens and LLM API keys live "on the box," adjacent to a prompt-injectable model runtime.

AgentHiFive eliminates both problems. Provider tokens and LLM credentials stay in the Vault; the agent host stores only short-lived session credentials and opaque connection IDs.

## Architecture overview

The integration consists of three packages that work together:

### Gateway Plugin (`@agenthifive/agenthifive`)

A combined **generic plugin** and **channel plugin** that runs in-process with the OpenClaw Gateway. It registers:

- **6 vault tools** -- `vault_execute`, `request_permission`, `request_capability`, `vault_await_approval`, `vault_connections_list`, and `vault_connection_revoke`
- **Hooks** -- a `before_agent_start` hook that injects prompt context and API reference material so the agent knows which vault connections and capabilities are available
- **Credential provider** -- a `VaultCredentialProvider` that resolves LLM and service credentials through the vault instead of local profiles
- **Channel plugin** -- registers the `agenthifive` channel, enabling the agent to receive and respond to messages through vault-managed Slack and Telegram bots (messages route through the vault instead of using local bot tokens)

### Setup CLI (`@agenthifive/openclaw-setup`)

A standalone CLI that bootstraps an OpenClaw agent with AgentHiFive. It handles first-time setup, model selection, and reconnection. Critically, it **patches OpenClaw's compiled JavaScript** to intercept credential resolution at runtime, redirecting LLM API calls through the vault.

### MCP Server (`agenthifive-mcp`)

A Model Context Protocol server (stdio transport) that exposes vault tools to MCP-compatible clients like Claude Code, OpenCode, and other agent frameworks -- independent of OpenClaw.

## Two integration surfaces

AgentHiFive ships two complementary integration surfaces. You can adopt them independently or together.

### Surface A: Gateway Plugin (recommended for OpenClaw)

The `@agenthifive/agenthifive` npm package is a first-class OpenClaw Gateway plugin. It runs in-process with the Gateway (trusted boundary) and provides the full set of vault tools, hooks, credential provider, and channel integration.

- Best UX and security posture for OpenClaw deployments.
- Bundled prompt injection teaches the agent safe usage patterns automatically.
- Stores at most vault session credentials and `connection_id` references -- no provider tokens.

See the [Plugin Guide](./plugin-guide.md) for installation and configuration.

### Surface B: MCP Server (portability)

The `agenthifive-mcp` server exposes connect, execute, and revoke tools over the Model Context Protocol. This lets Claude Code and other MCP-compatible agent clients consume AgentHiFive capabilities without running OpenClaw.

See the [MCP Server](./mcp-server.md) guide for setup instructions.

## How it works

### Setup and patching

1. **Bootstrap.** The setup CLI generates an ES256 key pair, registers the agent with the AgentHiFive vault using a bootstrap secret, and stores the private key locally.
2. **Patch.** The CLI locates OpenClaw's compiled JS chunks (or TypeScript source) and injects code into `resolveApiKeyForProvider()`. The patch adds two tiers before OpenClaw's normal local profile resolution:
   - **Tier 0 (Proxied providers):** For LLM providers marked as vault-managed, the patch returns the vault bearer token directly as the API key.
   - **Tier 0.5 (Credential provider chain):** For other providers, the patch queries the vault's credential provider before falling back to local profiles.
3. **Base URL rewrite.** LLM provider base URLs are rewritten to `{vaultUrl}/v1/vault/llm/{provider}`, so all LLM API traffic routes through the vault's Model B proxy.
4. **Header injection.** A second patch in `applyLocalNoAuthHeaderOverride()` injects session keys and approval replay headers into vault-proxied requests.

### Runtime flow

```
Agent makes LLM call (e.g., to Claude, GPT-4)
  → Patched credential resolver returns vault bearer token
  → Request goes to {vaultUrl}/v1/vault/llm/{provider} (Model B proxy)
  → Vault authenticates the agent, checks policies, proxies to real provider
  → Response returns through the vault to the agent
```

For explicit vault operations (sending emails, reading calendars, managing Notion pages, etc.):

```
Agent calls vault_execute with connectionId + request details
  → Plugin sends request to vault API
  → Vault checks policies, injects provider credentials, proxies to provider
  → If step-up approval required: vault returns 202, user approves in dashboard
  → Result + audit_id returned to agent
```

For vault-managed messaging channels:

```
User sends message via Slack or Telegram
  → Message routes through vault-managed bot to OpenClaw
  → Channel plugin receives message via the "agenthifive" channel
  → Agent processes and responds through the same vault-managed channel
```

## Target users

| User | Use case |
|---|---|
| **OpenClaw operators** (local or VPS) | Secure provider access without localhost callbacks or token-on-disk risk |
| **Skill authors** | Build tools against `vault_*` instead of managing OAuth directly |
| **MCP client users** | Use vault capabilities from Claude Code or other MCP-compatible agents |
| **Security-conscious end users** | Enforce separation between model runtime and secrets |

## Key benefits

### No tokens on the box

Provider refresh tokens and LLM API keys are stored exclusively in the AgentHiFive Vault. The OpenClaw host never sees them, even momentarily. LLM calls are proxied through the vault so the real API key never reaches the agent host. This holds true for local, VPS, and sandboxed deployments.

### Policy engine

Every execution request is checked against configurable policies before reaching the provider API:

- URL allowlists and method restrictions
- Payload and response size caps
- Redaction filters for sensitive data (emails, attachments, secrets)
- Risk-based step-up approvals for destructive actions

### Audit trail

Every action returns an `audit_id` that correlates across AgentHiFive and OpenClaw logs. This enables compliance reporting, incident investigation, and user-facing transparency.

### Remote-friendly connect flow

Connecting a provider account works the same way on a laptop and a headless VPS:

1. User initiates connection via the AgentHiFive dashboard or API.
2. User opens the OAuth URL on any device (phone, laptop) and approves.
3. Agent can list connections via `vault_connections_list` to discover available `connection_id`s.
4. No localhost callback, no SSH tunnel, no device-code workaround.

## Security model

| Boundary | Trust level | What it stores |
|---|---|---|
| LLM / agent runtime | **Untrusted** (prompt-injection assumed) | Nothing sensitive |
| OpenClaw Gateway + plugin | **Trusted** (user-controlled host) | Vault session credentials, connection IDs, ES256 private key |
| AgentHiFive Vault | **Credential boundary** | Provider refresh tokens, LLM API keys, policies, audit log |

:::info Default safety posture
- Read-only by default.
- Step-up approval required for destructive actions (send, delete, modify, share, export).
- LLM calls can require approval for high-cost models or unusual usage patterns.
- Generic HTTP calls restricted to allowlisted base URLs with strict caps and redaction.
:::

## What's next

- [How It Works](./how-it-works.md) -- patching, credential resolution tiers, and the runtime bridge
- [Plugin Guide](./plugin-guide.md) -- install and configure the Gateway plugin
- [MCP Server](./mcp-server.md) -- set up the MCP server for Claude Code and other clients
- [Policy Guards](./policy-guards.md) -- configure policies for your deployment
- [Risk Matrix](./risk-matrix.md) -- understand the risk classification model
- [Integration Matrix](./integration-matrix.md) -- supported providers and capabilities
