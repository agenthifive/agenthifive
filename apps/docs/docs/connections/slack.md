---
title: Slack Bot
sidebar_position: 5
sidebar_label: Slack
description: Connect a Slack bot to AgentHiFive using a Bot User OAuth Token.
---

# Slack Bot

Connect a Slack bot to let agents read channels, send messages, and upload files in your Slack workspace.

## Prerequisites

- A Slack workspace where you have admin permissions
- A Slack App created at [api.slack.com/apps](https://api.slack.com/apps)

## Creating a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, give it a name, and select your workspace
3. Go to **OAuth & Permissions** in the sidebar
4. Under **Bot Token Scopes**, add the scopes you need:

| Scope | Capability |
|-------|-----------|
| `channels:history` | Read messages in public channels |
| `channels:read` | List public channels |
| `chat:write` | Send messages |
| `files:read` | Read files |
| `files:write` | Upload files |
| `users:read` | Get user info |
| `reactions:write` | Add reactions |

5. Click **Install to Workspace** at the top of the page
6. After installing, copy the **Bot User OAuth Token** (starts with `xoxb-`)

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Communication** tab
3. Click **Connect Slack Bot**
4. Paste your Bot User OAuth Token (`xoxb-...`)
5. Click **Validate & Connect**

:::info Singleton
Slack is a **singleton** service -- only one bot per workspace.
:::

## Vault API Usage

:::warning All Slack Methods Use POST
Slack's API is **not standard REST**. Every method uses `POST`, even read operations like listing channels or reading message history. Never use `GET` for Slack API calls.
:::

```
// Correct -- read messages with POST
vault_execute({
  service: "slack",
  method: "POST",
  url: "https://slack.com/api/conversations.history",
  body: { channel: "C0123456789", limit: 10 }
})

// Wrong -- GET does not work for Slack
vault_execute({
  service: "slack",
  method: "GET",
  url: "https://slack.com/api/conversations.history?channel=C0123456789"
})
```

## Common API Methods

All methods use `POST` with parameters in the JSON body.

| Method | URL | Body |
|--------|-----|------|
| Read messages | `conversations.history` | `{ channel, limit }` |
| Read thread | `conversations.replies` | `{ channel, ts }` |
| List channels | `conversations.list` | `{ types, limit }` |
| Send message | `chat.postMessage` | `{ channel, text }` |
| Update message | `chat.update` | `{ channel, ts, text }` |
| Upload file | `files.uploadV2` | `{ channel_id, content, filename }` |
| Get user info | `users.info` | `{ user }` |
| Add reaction | `reactions.add` | `{ channel, timestamp, name }` |

All URLs use the base `https://slack.com/api/` prefix.

## Restricting Channel and User Access

You can restrict which channels and users the agent can interact with by setting **provider constraints** on the policy. This is configured in the dashboard when creating or editing a policy, or via the API.

Two dimensions are available:

- **Allowed Channels** (`allowedChannelIds`): Restricts which channels the agent can read from and post to. Outbound messages to non-allowed channels are blocked (403). Inbound `conversations.list` responses are filtered to only show allowed channels.
- **Allowed Users** (`allowedUserIds`): Filters inbound `conversations.history` and `conversations.replies` responses to only include messages from allowed users. Bot and system messages are always kept.

If either list is empty or omitted, no restriction is applied for that dimension.

**Finding IDs:**
- **Channel ID**: Open the channel → click the **channel name in the header** (top of the chat area) → scroll to the bottom of the **About** tab for the Channel ID (e.g., `C0123456789`).
- **Member ID**: Click a user's **profile picture** → click the **three dots (⋮)** → **Copy member ID** (e.g., `U0123456789`).

When a trusted list is set, the policy's send approval rules are automatically relaxed for trusted channels — sending does not require step-up approval.
