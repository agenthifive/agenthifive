---
title: Notion
sidebar_position: 10
sidebar_label: Notion
description: Connect Notion to AgentHiFive using an internal integration token to let agents read and manage pages, databases, and blocks.
---

# Notion

Connect Notion to let agents search, read, and manage pages, databases, and blocks in your Notion workspace through the vault.

## Prerequisites

- A Notion account with admin access to the target workspace

## Creating a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **New integration**
3. Select the workspace to connect
4. Give it a name (e.g., "AgentHiFive")
5. Under **Type**, leave it as **Internal**
6. Click **Save**
7. Copy the **Internal Integration Secret** (starts with `ntn_` or `secret_`)

:::tip Share Pages with the Integration
After creating the integration, you must explicitly share pages and databases with it. Open each page or database you want the agent to access, click **...** → **Connect to** → select your integration name.
:::

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Data Access** tab
3. Click **Connect Notion**
4. Paste your integration token
5. Click **Save**

:::info Permanent Tokens
Notion internal integration tokens are **permanent** — they don't expire and don't need to be refreshed. Access remains valid until you regenerate the token in your Notion integration settings.
:::

## Vault API Usage

### Model B (Brokered Proxy)

Notion connections only support Model B. The vault injects the `Authorization: Bearer` header automatically.

```
vault_execute({
  model: "B",
  connectionId: "your-notion-connection-id",
  method: "POST",
  url: "https://api.notion.com/v1/search",
  headers: { "Notion-Version": "2022-06-28" },
  body: {
    query: "project roadmap"
  }
})
```

:::warning Notion-Version Header Required
Every Notion API request requires the `Notion-Version` header. Pass it in the `headers` field of your vault_execute call.
:::

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| POST | `/v1/search` | Search pages and databases |
| GET | `/v1/pages/:id` | Retrieve a page |
| GET | `/v1/pages/:id/properties/:prop_id` | Retrieve a page property |
| POST | `/v1/pages` | Create a page |
| PATCH | `/v1/pages/:id` | Update a page |
| GET | `/v1/databases/:id` | Retrieve a database |
| POST | `/v1/databases/:id/query` | Query a database |
| GET | `/v1/blocks/:id` | Retrieve a block |
| GET | `/v1/blocks/:id/children` | List block children |
| PATCH | `/v1/blocks/:id` | Update a block |
| DELETE | `/v1/blocks/:id` | Delete (archive) a block |
| PATCH | `/v1/blocks/:id/children` | Append block children |
| GET | `/v1/comments` | List comments |
| POST | `/v1/comments` | Create a comment |
| GET | `/v1/users` | List users |
| GET | `/v1/users/me` | Get current bot user |

## Notes

- Notion uses **POST** for search (`/v1/search`) and database queries (`/v1/databases/:id/query`). These are read operations despite using POST.
- The integration can only access pages and databases that have been explicitly shared with it.
- Model A (token vending) is not supported for Notion — the API key must not be exposed to the agent.
