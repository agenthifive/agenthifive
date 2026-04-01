---
title: Vault GOG Strategy
sidebar_position: 8
sidebar_label: Vault GOG Strategy
description: Roadmap for integrating AgentHiFive's Vault as a credential backend for gogcli, the Google Workspace CLI used by OpenClaw agents.
---

# Vault GOG Strategy

:::info Status
This strategy is **parked for later review**. It depends on the `POST /credentials/resolve` Vault API being stable, which will be validated after the OpenClaw fork Phase 1 (CredentialProvider for model providers) is working.
:::

## Background

[`gogcli`](https://github.com/steipete/gogcli) (the `gog` command) is the Google Workspace CLI commonly used by OpenClaw agents for Gmail, Drive, Docs, Sheets, Calendar, and Contacts. It manages its own OAuth2 tokens internally (`~/.config/gog/`), bypassing all OpenClaw credential resolvers.

This creates the same "token on the box" problem that AgentHiFive solves for other integrations: refresh tokens live on disk, adjacent to an untrusted model runtime.

## Goal

Fork or contribute to `steipete/gogcli` to delegate credential storage -- and optionally API proxying -- to AgentHiFive's Vault. A vault-backed `gog` benefits **any gog user**, not just OpenClaw deployments.

## Why this matters

- `gog` manages OAuth2 tokens internally via OS keyring (macOS Keychain, Linux secret-service, Windows Credential Manager), bypassing all OpenClaw credential resolvers.
- OpenClaw agents use `gog` for critical data surfaces: Gmail, Drive, Docs, Sheets, Calendar, Contacts.
- AgentHiFive already has a brokered Google API access story (Model B proxy) -- vault-gog extends it to the CLI layer.
- Wider reach than modifying OpenClaw alone: every gog user gets vault-backed credential storage.

## gogcli facts

| Property | Value |
|---|---|
| Repository | `steipete/gogcli` on GitHub |
| Stars | 1,500+ |
| Language | Go |
| Auth | OAuth2 with OS keyring |
| Version | v0.9.0 (Jan 2026), 494 commits, actively maintained |
| Coverage | Gmail, Drive, Docs, Sheets, Calendar, Contacts |

## Three options

### Option A: Fork (`agenthifive-gog`)

Replace the keyring backend with vault HTTP calls to `POST /credentials/resolve`. Ship as a drop-in replacement binary. OpenClaw config points to `agenthifive-gog` instead of `gog`.

| Pros | Cons |
|---|---|
| Full control, ships independently | Fork maintenance burden (must track upstream) |

### Option B: Upstream PR to steipete/gogcli

Propose a `CredentialBackend` interface (the keyring is already abstracted in Go) and add `vault` as a built-in backend alongside keyring.

| Pros | Cons |
|---|---|
| Benefits all gog users, no fork divergence | Depends on maintainer acceptance; timeline uncertain |

### Option C: Hybrid (recommended)

1. Open an issue/PR upstream first.
2. If accepted: AgentHiFive becomes a first-class credential backend.
3. If rejected or slow: fork with minimal diff.

This follows the same pattern as the OpenClaw fork strategy (Path 3: Fork, build a PoC, then upstream PR).

## Go keyring insertion point

The keyring abstraction in Go is already well-isolated. The vault backend would implement the same interface:

```go
type VaultKeyring struct {
    endpoint   string // e.g. https://vault.agenthifive.com
    agentToken string
}

func (v *VaultKeyring) Get(service, user string) (string, error) {
    // POST /credentials/resolve { kind: "oauth", provider: "google", ... }
}

func (v *VaultKeyring) Set(service, user, password string) error {
    // POST /credentials/store { ... }
}
```

This approach keeps the diff small: a new `VaultKeyring` struct that satisfies the existing keyring interface, plus a configuration flag to select it.

## When to revisit

After the OpenClaw fork Phase 1 (CredentialProvider for model providers) is working. The vault-gog fork uses the same `POST /credentials/resolve` endpoint, so it depends on that API being stable.

## Related resources

- [himalaya](https://github.com/sostrovsky/himalaya) (IMAP/SMTP CLI) -- the same vault-backend pattern could apply if himalaya gains traction in agent workflows.
- OpenClaw fork implementation plan: `Doc/Integrations/OpenClaw/FORK_IMPLEMENTATION_PLAN.md`
- Credential architecture analysis: `Doc/Integrations/OpenClaw/CREDENTIAL_ARCHITECTURE_ANALYSIS.md`
