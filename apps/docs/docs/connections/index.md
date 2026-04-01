---
title: Connections
sidebar_position: 1
sidebar_label: Overview
description: How to connect external services (Google, Microsoft, Telegram, Slack, Notion, LLM providers) to AgentHiFive.
---

# Connections

Connections link your external service accounts to AgentHiFive so that AI agents can access them through the vault. Each connection stores encrypted credentials and is scoped to your workspace.

## Connection Types

| Type | Auth Method | How It Works |
|------|-------------|-------------|
| **OAuth** | Browser-based consent | You click "Connect", authorize in the provider's login page, and tokens are stored automatically. |
| **Bot Token** | Paste a token | You create a bot in the provider's platform, copy the token, and paste it in the dashboard. |
| **API Key** | Paste a key or token | You get a key from the provider's console and paste it in the dashboard. |

## Supported Providers

### Data & Productivity (OAuth)

| Service | Provider | What Agents Can Do |
|---------|----------|-------------------|
| [Gmail](./google) | Google | Read, search, and send emails |
| [Google Calendar](./google) | Google | Read and create calendar events |
| [Google Drive](./google) | Google | Read, search, and manage files |
| [Google Sheets](./google) | Google | Read and edit spreadsheets |
| [Google Docs](./google) | Google | Read and edit documents |
| [Outlook Mail](./microsoft) | Microsoft | Read and send emails |
| [Outlook Calendar](./microsoft) | Microsoft | Read and create calendar events |
| [Outlook Contacts](./microsoft) | Microsoft | Read and manage contacts |
| [OneDrive](./microsoft) | Microsoft | Read, upload, and manage files |
| [Microsoft Teams](./microsoft) | Microsoft | Read and send chat/channel messages |
| [Notion](./notion) | Notion | Read, search, and manage pages, databases, and blocks |

### Project Management (API Key)

| Service | Provider | What Agents Can Do |
|---------|----------|-------------------|
| [Trello](./trello) | Trello | Read boards/lists/cards, create and move cards |
| [Jira](./jira) | Jira Cloud | Read and create issues, manage sprints and projects |

### Communication (Bot Token)

| Service | Provider | What Agents Can Do |
|---------|----------|-------------------|
| [Telegram Bot](./telegram) | Telegram | Send and receive messages via a bot |
| [Slack Bot](./slack) | Slack | Read channels, send messages, upload files |

### LLM Access (API Key)

| Service | Provider | What Agents Can Do |
|---------|----------|-------------------|
| [Anthropic (Claude)](./anthropic) | Anthropic | Send messages to Claude models |
| [OpenAI](./openai) | OpenAI | Send completions to GPT models |
| [Google Gemini](./gemini) | Google | Send completions to Gemini models |
| [OpenRouter](./openrouter) | OpenRouter | Multi-model LLM gateway (OpenAI-compatible) |

## How Connections Work

1. **You create a connection** in the dashboard (Connections page or when approving an agent's permission request).
2. **Credentials are encrypted** with AES-256-GCM and stored in the database. They are never exposed to agents or shown in the UI after creation.
3. **You create a policy** that binds an agent to the connection with specific rules (rate limits, allowlists, time windows).
4. **The agent makes API calls** through the vault. The vault injects credentials, enforces policies, and logs an audit trail.

:::tip Singleton Connections
Some services (Telegram, Slack, Anthropic, OpenAI, Gemini, OpenRouter) are **singletons** -- only one connection per workspace. Agents refer to them by service name (e.g., `service: "telegram"`) instead of connection ID.
:::

## Next Steps

- Pick a provider from the list above to see setup instructions
- [Create a policy](../api-reference/agents-policies) to bind an agent to a connection
- [Test execution](../api-reference/execution) through the vault
