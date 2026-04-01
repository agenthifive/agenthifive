---
title: OpenRouter
sidebar_position: 9
sidebar_label: OpenRouter
description: Connect OpenRouter's multi-model LLM gateway to AgentHiFive using an API key.
---

# OpenRouter

Connect OpenRouter to let agents access multiple LLM providers (OpenAI, Anthropic, Google, Meta, etc.) through a single OpenAI-compatible API via the vault.

## Prerequisites

- An OpenRouter account at [openrouter.ai](https://openrouter.ai/)

## Getting Your API Key

1. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
2. Click **Create Key**
3. Give it a name and copy the key (starts with `sk-or-v1-...`)

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **LLM Access** tab
3. Click **Connect OpenRouter**
4. Paste your API key
5. Click **Connect**

:::info Singleton
OpenRouter is a **singleton** service -- only one connection per workspace. Agents use `service: "openrouter"` instead of a connection ID.
:::

## Vault API Usage

```
vault_execute({
  service: "openrouter",
  method: "POST",
  url: "https://openrouter.ai/api/v1/chat/completions",
  body: {
    model: "anthropic/claude-sonnet-4",
    messages: [{ role: "user", content: "Hello!" }]
  }
})
```

The vault automatically adds the `Authorization: Bearer` header.

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/completions` | Send a chat completion request |
| POST | `/api/v1/embeddings` | Generate embeddings |
| GET | `/api/v1/models` | List available models |

## Model Naming

OpenRouter uses `provider/model` format for model names (e.g., `anthropic/claude-sonnet-4`, `openai/gpt-4o`, `google/gemini-2.0-flash`). See [openrouter.ai/models](https://openrouter.ai/models) for the full list.
