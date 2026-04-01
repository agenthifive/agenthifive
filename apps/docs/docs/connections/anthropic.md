---
title: Anthropic (Claude)
sidebar_position: 6
sidebar_label: Anthropic
description: Connect Anthropic's Claude API to AgentHiFive using an API key or Claude Code setup token.
---

# Anthropic (Claude)

Connect the Anthropic API to let agents send messages to Claude models through the vault.

## Prerequisites

You need **one** of the following:

- **API Key** from [console.anthropic.com](https://console.anthropic.com/) -- usage-based billing
- **Claude Code Setup Token** -- uses your Claude Pro or Max subscription

## Getting Your Credentials

### Option A: API Key (Usage-Based)

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Navigate to **API Keys**
3. Click **Create Key**
4. Copy the key (starts with `sk-ant-api03-...`)

### Option B: Claude Code Setup Token (Subscription)

If you have a Claude Pro or Max subscription, you can use your subscription quota instead of paying per-API-call:

1. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) if you haven't already
2. Run `claude setup-token` in your terminal
3. Copy the token (starts with `sk-ant-oat01-...`)

:::tip Which Should I Use?
- **API key** if you want predictable per-token billing and higher rate limits
- **Setup token** if you already have a Pro/Max subscription and want to use your included quota
:::

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **LLM Access** tab
3. Click **Connect Anthropic (Claude)**
4. Paste your API key or setup token
5. Click **Connect**

Both token types work in the same input field -- AgentHiFive accepts either format.

:::info Singleton
Anthropic is a **singleton** service -- only one connection per workspace. Agents use `service: "anthropic-messages"` instead of a connection ID.
:::

## Vault API Usage

```
vault_execute({
  service: "anthropic-messages",
  method: "POST",
  url: "https://api.anthropic.com/v1/messages",
  body: {
    model: "claude-sonnet-4-5-20250929",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello, Claude!" }]
  }
})
```

The vault automatically adds the authentication header and `anthropic-version` header.

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| POST | `/v1/messages` | Send a message to Claude |
| GET | `/v1/models` | List available models |
| GET | `/v1/models/{id}` | Get model details |
