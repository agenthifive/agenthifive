---
title: Trello
sidebar_position: 11
sidebar_label: Trello
description: Connect Trello to AgentHiFive using an API key and user token to let agents read and manage boards, lists, and cards.
---

# Trello

Connect Trello to let agents read and manage boards, lists, cards, and comments through the vault.

## Prerequisites

- A Trello account
- A Trello Power-Up (for the API key)

## Creating a Trello Power-Up

1. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin)
2. Click **New** to create a new Power-Up
3. Fill in the required fields:
   - **Name**: e.g., "AgentHiFive"
   - **Workspace**: select your workspace
   - **Iframe connector URL**: can be left blank (not needed for API access)
4. Click **Create**
5. In the Power-Up settings, find the **API Key** — copy this for the connection setup

## Generating a User Token

1. Visit the authorization URL (replace `YOUR_API_KEY` with your Power-Up API key):
   ```
   https://trello.com/1/authorize?expiration=never&scope=read,write&response_type=token&key=YOUR_API_KEY&name=AgentHiFive
   ```
2. Click **Allow** to grant access
3. Copy the token displayed on the page

:::tip Token Permissions
The `scope=read,write` parameter grants both read and write access. For read-only access, use `scope=read`.
:::

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Data Access** tab
3. Click **Trello** → **Connect**
4. Enter your **Power-Up API Key** (from step 5 of Power-Up creation)
5. Enter your **User Token** (from the authorization step above)
6. Click **Connect**

Both credentials are stored encrypted per-connection. Each workspace can use a different Power-Up.

:::info Permanent Tokens
Trello tokens generated with `expiration=never` are permanent — they don't expire. Access remains valid until you revoke the token at [trello.com/your/account](https://trello.com/your/account) under **Applications**.
:::

## Vault API Usage

### Model B (Brokered Proxy)

Trello connections only support Model B. The vault automatically appends `key` and `token` query parameters to every request — do not include them yourself.

```
vault_execute({
  model: "B",
  connectionId: "your-trello-connection-id",
  method: "GET",
  url: "https://api.trello.com/1/members/me/boards"
})
```

:::warning Do Not Include Credentials in URLs
The vault injects the API key and user token automatically. Never pass `key` or `token` as query parameters in your request URL — they will be added by the proxy.
:::

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| GET | `/1/members/me/boards` | List your boards |
| GET | `/1/boards/:id` | Get a board |
| GET | `/1/boards/:id/lists` | List board lists |
| GET | `/1/boards/:id/cards` | List board cards |
| GET | `/1/boards/:id/labels` | List board labels |
| GET | `/1/lists/:id` | Get a list |
| GET | `/1/lists/:id/cards` | List cards in a list |
| POST | `/1/lists` | Create a list |
| PUT | `/1/lists/:id` | Update a list |
| GET | `/1/cards/:id` | Get a card |
| GET | `/1/cards/:id/actions` | List card activity |
| GET | `/1/cards/:id/attachments` | List card attachments |
| GET | `/1/cards/:id/checklists` | List card checklists |
| POST | `/1/cards` | Create a card |
| PUT | `/1/cards/:id` | Update a card |
| DELETE | `/1/cards/:id` | Delete a card |
| POST | `/1/cards/:id/actions/comments` | Add a comment to a card |

## Notes

- Trello uses query parameter authentication (`?key=...&token=...`), not Bearer tokens. The vault handles this automatically.
- Model A (token vending) is not supported — the user token grants full account access and must not be exposed to the agent.
- To archive a card instead of deleting it, use `PUT /1/cards/:id` with `{ "closed": true }` in the body.
- Both the Power-Up API key and user token are stored per-connection in the encrypted vault — no server-level environment variables are needed for Trello.
