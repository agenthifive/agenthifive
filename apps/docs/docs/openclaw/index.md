---
title: OpenClaw Integration
sidebar_position: 1
sidebar_label: Overview
description: Route delegated access through AgentHiFive so provider tokens never live in OpenClaw — keeping agents safer on local, VPS, and sandboxed deployments.
---

# OpenClaw Integration

AgentHiFive integrates with [OpenClaw](https://github.com/anthropics/openclaw) to provide secure, auditable authority delegation for AI agents. Instead of storing OAuth refresh tokens on the agent host, AgentHiFive acts as the credential boundary: the agent runtime never sees provider secrets, and every action is policy-checked and audit-logged.

## The problem today

OpenClaw agents commonly use external CLIs (like `gog` for Google Workspace) and store auth profiles locally. On VPS and remote gateway deployments this creates two issues:

- **UX friction** -- localhost OAuth callbacks require SSH tunnels or device-code workarounds.
- **Security risk** -- refresh tokens live "on the box," adjacent to a prompt-injectable model runtime.

AgentHiFive eliminates both problems. Provider tokens stay in the Vault; the agent host stores only short-lived session credentials and opaque connection IDs.

## Three integration surfaces

AgentHiFive ships three complementary integration surfaces. You can adopt them progressively.

### Surface A: Gateway Plugin (recommended)

The `@agenthifive/openclaw` npm package is a first-class OpenClaw Gateway plugin. It runs in-process with the Gateway (trusted boundary) and registers `agenthifive.*` tools the agent can call.

- Best UX and security posture.
- Bundled skill (`SKILL.md`) teaches the agent safe usage patterns automatically.
- Stores at most Vault session credentials and `connection_id` references -- no provider tokens.

See the [Plugin Guide](./plugin-guide.md) for installation and configuration.

### Surface B: CLI Compatibility Layer

The `agentgog` CLI is a drop-in replacement for `gog` (the Google Workspace CLI) that delegates execution to AgentHiFive instead of storing tokens locally. This is the fastest way to upgrade existing OpenClaw workflows without rewriting skills.

- Implements the subset of `gog` commands that OpenClaw skills rely on.
- Local disk stores only `connection_id` mappings, not provider tokens.

See the [Vault GOG Strategy](./vault-gog-strategy.md) for the implementation roadmap.

### Surface C: MCP Server (portability)

The `@agenthifive/mcp` server exposes connect, execute, and revoke tools over the Model Context Protocol. This lets OpenClaw and other agent clients (Claude Code, OpenCode, etc.) consume AgentHiFive capabilities portably.

See the [MCP Server](./mcp-server.md) guide for setup instructions.

## Target users

| User | Use case |
|---|---|
| **OpenClaw operators** (local or VPS) | Secure provider access without localhost callbacks or token-on-disk risk |
| **Skill authors** | Build tools against `agenthifive.*` instead of managing OAuth directly |
| **Security-conscious end users** | Enforce separation between model runtime and secrets |

## Key benefits

### No tokens on the box

Provider refresh tokens are stored exclusively in the AgentHiFive Vault. The OpenClaw host never sees them, even momentarily. This holds true for local, VPS, and sandboxed deployments.

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
3. Agent can list connections via `connections_list` to discover available `connection_id`s.
4. No localhost callback, no SSH tunnel, no device-code workaround.

## Core UX flows

### Connect a provider account

```
User:  "Connect my Gmail"
User:  initiates connection via dashboard → approves OAuth
Agent: calls agenthifive.connections_list → discovers connection_id
Agent: "Connected: Gmail (read-only)"
```

### Execute a read operation

```
Agent: calls agenthifive.execute with a GET request
Vault: checks allowlist, enforces caps, redacts sensitive fields
Agent: receives structured result + audit_id
```

### Execute a write with approval ("high-five")

```
Agent: drafts the write action
Agent: calls vault_execute → vault returns 202 (approval required)
User:  approves via dashboard
Agent: re-calls vault_execute with approvalId → action executes
Agent: receives result + audit_id
```

## Security model

| Boundary | Trust level | What it stores |
|---|---|---|
| LLM / agent runtime | **Untrusted** (prompt-injection assumed) | Nothing sensitive |
| OpenClaw Gateway + plugin | **Trusted** (user-controlled host) | Vault session credentials, connection IDs |
| AgentHiFive Vault | **Credential boundary** | Provider refresh tokens, policies, audit log |

:::info Default safety posture
- Read-only by default.
- Step-up approval required for destructive actions (send, delete, modify, share, export).
- Generic HTTP calls restricted to allowlisted base URLs with strict caps and redaction.
:::

## What's next

- [Plugin Guide](./plugin-guide.md) -- install and configure the Gateway plugin
- [MCP Server](./mcp-server.md) -- set up the MCP server for Claude Code and other clients
- [Vault GOG Strategy](./vault-gog-strategy.md) -- roadmap for vault-backed `gog` CLI
