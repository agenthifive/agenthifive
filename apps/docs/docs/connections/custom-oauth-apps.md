---
title: Custom OAuth Apps
sidebar_position: 10
sidebar_label: Custom OAuth Apps
description: Use your own Google or Microsoft OAuth app credentials with AgentHiFive.
---

# Custom OAuth Apps

By default, AgentHiFive uses the instance-wide OAuth credentials configured by your administrator (via environment variables). If those are not available — for example in a self-hosted or trial setup — you can register your own OAuth app and add its credentials in the dashboard.

:::info When to use this
You only need custom OAuth apps if your AgentHiFive instance does not have Google or Microsoft OAuth credentials pre-configured. If "Connect" buttons on the Connections page already work, you're all set.
:::

## Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create or select a project
2. Enable the APIs you need (Gmail API, Google Calendar API, Google Drive API, Google Sheets API, Google Docs API)
3. Go to **Credentials** → **Create Credentials** → **OAuth Client ID**
4. Application type: **Web application**
5. Under **Authorized redirect URIs**, add the callback URL shown in your AgentHiFive Settings page
6. Copy the **Client ID** and **Client Secret**
7. In AgentHiFive, go to **Settings** → **Google OAuth App** and paste them

## Microsoft

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) and click **New registration**
2. Name: anything you like (e.g. `AgentHiFive`)
3. Supported account types: choose based on your needs (single tenant, multi-tenant, or personal accounts)
4. Redirect URI: paste the callback URL shown in your AgentHiFive Settings page (platform type: **Web**)
5. After registration, go to **Certificates & secrets** → **New client secret** and copy the value
6. Add any **API permissions** you need (Microsoft Graph: `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, `Files.ReadWrite`, `Chat.ReadWrite`, etc.)
7. Copy the **Application (client) ID**, **Client Secret**, and optionally the **Directory (tenant) ID**
8. In AgentHiFive, go to **Settings** → **Microsoft OAuth App** and paste them

:::tip Tenant ID
If you leave Tenant ID empty, AgentHiFive defaults to `common`, which allows any Microsoft account (work, school, or personal) to sign in. Set a specific tenant ID to restrict to your organization.
:::

## How It Works

- Custom OAuth apps are scoped to your workspace — they don't affect other workspaces on the same instance.
- If both instance-wide (corporate) and custom (workspace) credentials exist for a provider, **new connections use the instance-wide credentials**. Custom credentials are a fallback.
- Connections created with custom credentials continue using them for token refreshes, even if instance-wide credentials are added later.
- Deleting a custom OAuth app does not break existing connections if instance-wide credentials are available — they'll fall back automatically on the next token refresh.
