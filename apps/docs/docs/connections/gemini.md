---
title: Google Gemini
sidebar_position: 8
sidebar_label: Gemini
description: Connect Google's Gemini API to AgentHiFive using an API key.
---

# Google Gemini

Connect the Google Gemini API to let agents send completions to Gemini models and generate embeddings through the vault.

## Prerequisites

- A Google AI Studio account at [aistudio.google.com](https://aistudio.google.com/)

## Getting Your API Key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click **Create API key**
3. Select or create a Google Cloud project
4. Copy the key (starts with `AIza...`)

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **LLM Access** tab
3. Click **Connect Google Gemini**
4. Paste your API key
5. Click **Connect**

:::info Singleton
Gemini is a **singleton** service -- only one connection per workspace. Agents use `service: "gemini"` instead of a connection ID.
:::

## Vault API Usage

```
vault_execute({
  service: "gemini",
  method: "POST",
  url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
  body: {
    contents: [{ parts: [{ text: "Hello!" }] }]
  }
})
```

The vault automatically adds the `x-goog-api-key` header.

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| POST | `/v1beta/models/{model}:generateContent` | Generate content |
| POST | `/v1beta/models/{model}:embedContent` | Generate embeddings |
| GET | `/v1beta/models` | List available models |
