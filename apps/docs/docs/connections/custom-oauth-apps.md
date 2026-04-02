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

## Setup

1. Go to **Settings** → **Apps** in the AgentHiFive dashboard
2. Note the **Callback URL** shown at the top — you'll need it when creating your OAuth app
3. Follow the provider-specific guide:

| Provider | Services | Guide |
|----------|----------|-------|
| **Google** | Gmail, Calendar, Drive, Sheets, Docs, Contacts | [Google Workspace setup guide](/connections/google#oauth-setup-admin) |
| **Microsoft** | Outlook Mail, Calendar, Contacts, OneDrive, Teams | [Microsoft setup guide](/connections/microsoft#oauth-setup-admin) |

4. Paste your Client ID and Client Secret into the corresponding form in **Settings** → **Apps**

## How It Works

- Custom OAuth apps are scoped to your workspace — they don't affect other workspaces on the same instance.
- If both instance-wide (corporate) and custom (workspace) credentials exist for a provider, **new connections use the instance-wide credentials**. Custom credentials are a fallback.
- Connections created with custom credentials continue using them for token refreshes, even if instance-wide credentials are added later.
- Deleting a custom OAuth app does not break existing connections if instance-wide credentials are available — they'll fall back automatically on the next token refresh.
