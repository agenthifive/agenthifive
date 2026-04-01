---
title: Telegram Bot
sidebar_position: 4
sidebar_label: Telegram
description: Connect a Telegram bot to AgentHiFive using a BotFather token.
---

# Telegram Bot

Connect a Telegram bot to let agents send and receive messages through Telegram.

## Prerequisites

- A Telegram account
- A bot created via [@BotFather](https://t.me/BotFather)

## Creating a Bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to name your bot
3. BotFather will give you a **bot token** like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`
4. Copy this token -- you'll paste it in the dashboard

:::tip Bot Settings
After creating the bot, you can use BotFather commands to customize it:
- `/setdescription` -- set the bot's description
- `/setabouttext` -- set the "About" text
- `/setuserpic` -- set the bot's profile picture
:::

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Communication** tab
3. Click **Connect Telegram Bot**
4. Paste your bot token from BotFather
5. Click **Validate & Connect** -- AgentHiFive will verify the token with Telegram's API
6. If valid, the connection is created with the bot's username as the label

:::info Singleton
Telegram is a **singleton** service -- only one bot per workspace. If you need to switch bots, revoke the current connection first.
:::

## How It Works

- **Sending messages**: Agents call `vault_execute` with the Telegram Bot API URL. The vault automatically injects the bot token into the URL path.
- **Receiving messages**: When using the OpenClaw integration, incoming messages are **auto-polled** by the vault. The agent does not need to call `getUpdates`.

## Vault API Usage

```
vault_execute({
  service: "telegram",
  method: "POST",
  url: "https://api.telegram.org/bot/sendMessage",
  body: { chat_id: 123456789, text: "Hello!" }
})
```

:::warning Token Injection
Do **not** put a real token in the URL. Use `https://api.telegram.org/bot/sendMessage` (with just `/bot/`) -- the vault rewrites it to `/bot<TOKEN>/sendMessage` automatically.
:::

## Common API Methods

| Method | HTTP | URL Path | Body |
|--------|------|----------|------|
| Send message | POST | `/bot/sendMessage` | `{ chat_id, text, parse_mode }` |
| Send photo | POST | `/bot/sendPhoto` | `{ chat_id, photo }` |
| Forward message | POST | `/bot/forwardMessage` | `{ chat_id, from_chat_id, message_id }` |
| Get chat info | GET | `/bot/getChat` | query: `{ chat_id }` |

## Restricting Chat Access

To limit which chats the bot can interact with, configure **provider constraints** on the policy:

1. Go to **Policies** in the dashboard
2. Edit the policy for this Telegram connection
3. Under **Provider Constraints**, add allowed chat IDs

If no chat IDs are configured, the bot can interact with all chats.
