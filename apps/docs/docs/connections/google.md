---
title: Google Workspace
sidebar_position: 2
sidebar_label: Google Workspace
description: Connect Gmail, Google Calendar, Google Drive, Google Sheets, and Google Docs to AgentHiFive.
---

# Google Workspace

Connect your Google account to let agents access Gmail, Google Calendar, Google Drive, Google Sheets, and Google Docs.

## Prerequisites

- A Google account with access to the services you want to connect
- OAuth credentials configured in your AgentHiFive instance (see below)

### OAuth Setup (Admin)

If you're self-hosting, you need to configure Google OAuth credentials:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project
2. Enable the APIs you need: Gmail API, Google Calendar API, Google Drive API
3. Go to **Credentials** > **Create Credentials** > **OAuth Client ID**
4. Application type: **Web application**
5. Add redirect URI: `https://your-domain.com/v1/connections/callback`
6. Copy the Client ID and Client Secret to your `.env`:

```env
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
```

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Data & Productivity** tab
3. Click the Google service you want (Gmail, Calendar, Drive, etc.)
4. You'll be redirected to Google's consent screen
5. Sign in and grant the requested permissions
6. You'll be redirected back with the connection active

:::info Multiple Connections
Google services support **multiple connections** per workspace (e.g., connect both your work and personal Gmail). Each connection has its own credentials and policies.
:::

## Available Services

| Service ID | Scopes Requested | Capabilities |
|-----------|-----------------|-------------|
| `google-gmail` | `gmail.readonly` or `gmail.modify` | Read messages, search, send emails, manage labels |
| `google-calendar` | `calendar.readonly` or `calendar.events` | Read events, create/modify events |
| `google-drive` | `drive.readonly` or `drive.file` | List files, read content, upload files |
| `google-sheets` | `spreadsheets.readonly` or `spreadsheets` | Read and edit spreadsheets |
| `google-docs` | `documents.readonly` or `documents` | Read and edit documents |

## Vault API Usage

Once connected, agents call the vault with the Google API URLs:

```
vault_execute({
  service: "google-gmail",
  connectionId: "your-connection-id",  // required -- Google supports multiple connections
  method: "GET",
  url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  query: { maxResults: "10" }
})
```

:::tip Connection ID Required
Since Google supports multiple connections, agents must pass `connectionId` (from `vault_connections_list`) to specify which account to use.
:::
