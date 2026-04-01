---
title: OpenAI
sidebar_position: 7
sidebar_label: OpenAI
description: Connect OpenAI's GPT API to AgentHiFive using an API key.
---

# OpenAI

Connect the OpenAI API to let agents send completions to GPT models and generate embeddings through the vault.

## Prerequisites

- An OpenAI account with API access at [platform.openai.com](https://platform.openai.com/)

## Getting Your API Key

1. Go to [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Click **Create new secret key**
3. Give it a name and copy the key (starts with `sk-...`)

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **LLM Access** tab
3. Click **Connect OpenAI**
4. Paste your API key
5. Click **Connect**

:::info Singleton
OpenAI is a **singleton** service -- only one connection per workspace. Agents use `service: "openai"` instead of a connection ID.
:::

## Vault API Usage

```
vault_execute({
  service: "openai",
  method: "POST",
  url: "https://api.openai.com/v1/chat/completions",
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello!" }]
  }
})
```

The vault automatically adds the `Authorization: Bearer` header.

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| POST | `/v1/chat/completions` | Send a chat completion request |
| POST | `/v1/embeddings` | Generate embeddings |
| GET | `/v1/models` | List available models |
