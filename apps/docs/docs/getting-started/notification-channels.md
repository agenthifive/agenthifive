---
sidebar_position: 7
title: Notification Channels
description: Configure external notification channels for approval requests and security alerts
---

# Notification Channels

Notification channels let you receive real-time alerts outside the AgentHiFive dashboard. When an agent requests approval or a security event is detected, AgentHiFive can notify you through Telegram, Slack, mobile push notifications, and the built-in in-app stream.

This is especially useful for time-sensitive approval requests that expire after a few minutes. Instead of polling the dashboard, you get a message with **Approve** and **Deny** buttons delivered directly to your preferred platform.

## Available Channel Types

### In-App Notifications (Always Enabled)

Every workspace has in-app notifications enabled by default. These are delivered via a Server-Sent Events (SSE) stream and appear in the dashboard notification bell. No configuration is required.

Notification types include:

| Type | Description |
|------|-------------|
| `permission_request` | An agent needs approval to make a request |
| `approval_resolved` | An approval was approved, denied, or expired |
| `connection_issue` | A connection has become unhealthy |
| `security_alert` | Suspicious activity detected |

Each notification includes a `title`, `body`, optional `linkUrl` for navigation, and optional `metadata` for structured data.

### Telegram Bot Notifications

Receive approval requests and security alerts in a Telegram chat. Approval notifications include inline **Approve** and **Deny** buttons that link to quick-action URLs. After resolution, the message is edited to show the outcome.

### Slack Bot Notifications

Receive notifications in a Slack channel. Approval notifications use Slack Block Kit with **Approve** and **Deny** action buttons. Security alerts include a link to the activity log.

### Mobile Push Notifications (Expo)

Push notifications are sent to all registered devices for the workspace. These use the Expo push notification service and are delivered with high priority on a dedicated `approvals` channel.

:::info
Push subscriptions are per-device and per-user, unlike Telegram and Slack channels which are per-workspace. A user may have multiple devices registered.
:::

## Setting Up Telegram Notifications

### Prerequisites

You must have an existing Telegram bot connection in your workspace. The connection must have a `healthy` status.

### Step 1: Detect Available Chats

Before creating a Telegram notification channel, you need the `chatId` of the chat where notifications should be sent. Send a message to your Telegram bot first, then use the detect-chats endpoint to discover it:

```bash
curl -X POST https://your-api/v1/notification-channels/telegram/detect-chats \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "connectionId": "YOUR_TELEGRAM_CONNECTION_ID" }'
```

This calls the Telegram `getUpdates` API and returns deduplicated chats:

```json
{
  "chats": [
    {
      "chatId": "123456789",
      "name": "John Doe",
      "type": "private",
      "username": "johndoe"
    },
    {
      "chatId": "-100987654321",
      "name": "My Alert Group",
      "type": "group",
      "username": null
    }
  ]
}
```

:::tip
If no chats appear, make sure someone has sent a message to the bot recently. Telegram only buffers recent updates.
:::

### Step 2: Create the Channel

```bash
curl -X POST https://your-api/v1/notification-channels \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channelType": "telegram",
    "connectionId": "YOUR_TELEGRAM_CONNECTION_ID",
    "config": { "chatId": "123456789" }
  }'
```

The response includes the new channel with `verificationStatus: "pending"`:

```json
{
  "channel": {
    "id": "a1b2c3d4-...",
    "channelType": "telegram",
    "enabled": true,
    "connectionId": "YOUR_TELEGRAM_CONNECTION_ID",
    "config": { "chatId": "123456789" },
    "verificationStatus": "pending"
  }
}
```

:::note
Only one channel per type per workspace is allowed. If a Telegram channel already exists, the POST request will update it (upsert behavior).
:::

### Step 3: Test and Verify

Send a test notification to confirm the channel works:

```bash
curl -X POST https://your-api/v1/notification-channels/CHANNEL_ID/test \
  -H "Authorization: Bearer YOUR_TOKEN"
```

On success, the channel's `verificationStatus` is automatically updated to `"verified"`. Only verified channels receive real notifications.

### Enabling and Disabling

Toggle a channel without deleting it:

```bash
curl -X PATCH https://your-api/v1/notification-channels/CHANNEL_ID/enabled \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "enabled": false }'
```

## Setting Up Slack Notifications

### Prerequisites

You must have an existing Slack bot connection in your workspace with a `healthy` status. The bot must have permission to post to the target channel.

### Step 1: Get Your Channel ID

Find the Slack channel ID where you want notifications delivered. In Slack, right-click a channel name, select **Copy link**, and extract the ID from the URL (it starts with `C`).

### Step 2: Create the Channel

```bash
curl -X POST https://your-api/v1/notification-channels \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channelType": "slack",
    "connectionId": "YOUR_SLACK_CONNECTION_ID",
    "config": { "channelId": "C0123ABCDEF" }
  }'
```

### Step 3: Test and Verify

```bash
curl -X POST https://your-api/v1/notification-channels/CHANNEL_ID/test \
  -H "Authorization: Bearer YOUR_TOKEN"
```

You should see a test message appear in your Slack channel. The channel status will be updated to `"verified"`.

## Mobile Push Notifications

Mobile push notifications are handled differently from Telegram and Slack. Instead of a workspace-level notification channel, push notifications use per-device subscriptions stored in the `t_push_subscriptions` table.

Each subscription includes:

| Field | Description |
|-------|-------------|
| `expoPushToken` | The Expo push token for the device |
| `platform` | `"ios"` or `"android"` |
| `deviceName` | Optional human-readable device name |

When an approval request or security alert is created, AgentHiFive automatically sends push notifications to all registered devices for the workspace. Invalid or expired tokens are cleaned up automatically.

Push notifications are sent with:
- **Priority:** `high`
- **Channel ID:** `approvals`
- **Sound:** `default`

The notification `data` payload includes a `type` field (`"approval_request"` or `"security_alert"`) and a `url` field for deep linking.

## API Reference

All endpoints require authentication via Bearer token and are scoped to the current workspace.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/notification-channels` | List all notification channels for the workspace |
| `POST` | `/v1/notification-channels` | Create or update a notification channel (upserts on workspace + channel type) |
| `POST` | `/v1/notification-channels/:id/test` | Send a test message and mark the channel as verified on success |
| `PATCH` | `/v1/notification-channels/:id/enabled` | Toggle the enabled/disabled status of a channel |
| `DELETE` | `/v1/notification-channels/:id` | Permanently remove a notification channel |
| `POST` | `/v1/notification-channels/telegram/detect-chats` | Discover Telegram chats that have recently messaged the bot |

### Request and Response Shapes

**POST /v1/notification-channels** body:

```json
{
  "channelType": "telegram" | "slack",
  "connectionId": "uuid",
  "config": {
    "chatId": "string"       // required for Telegram
    "channelId": "string"    // required for Slack
  }
}
```

**PATCH /v1/notification-channels/:id/enabled** body:

```json
{
  "enabled": true | false
}
```

**POST /v1/notification-channels/telegram/detect-chats** body:

```json
{
  "connectionId": "uuid"
}
```

## SSE Real-Time Stream

The SSE endpoint provides real-time in-app notifications without polling.

**Endpoint:** `GET /v1/notifications/stream`

**Authentication:** Standard Bearer token in the `Authorization` header. If connecting from a context where custom headers are not supported (such as `EventSource` in some browsers), pass the token as a query parameter.

**Connection flow:**

1. Client opens an SSE connection
2. Server sends an `event: connected` event with empty data (`{}`)
3. Server sends `event: notification` events as they arrive, with JSON data
4. Server sends `: heartbeat` comments every 30 seconds to keep the connection alive

**Example event:**

```
event: notification
data: {"id":"abc-123","type":"permission_request","title":"Approval Required","body":"MyAgent wants to GET api.example.com/users","linkUrl":"/dashboard/approvals","read":false,"metadata":{"approvalId":"def-456"},"createdAt":"2026-01-15T10:30:00.000Z"}
```

**Headers returned by the server:**

| Header | Value |
|--------|-------|
| `Content-Type` | `text/event-stream` |
| `Cache-Control` | `no-cache` |
| `Connection` | `keep-alive` |
| `X-Accel-Buffering` | `no` (disables Nginx buffering) |

**Example client usage:**

```javascript
const eventSource = new EventSource(
  "https://your-api/v1/notifications/stream",
  { headers: { Authorization: "Bearer YOUR_TOKEN" } }
);

eventSource.addEventListener("connected", () => {
  console.log("Notification stream connected");
});

eventSource.addEventListener("notification", (event) => {
  const notification = JSON.parse(event.data);
  console.log("New notification:", notification.title);
});
```
