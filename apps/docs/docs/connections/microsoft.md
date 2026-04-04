---
title: Microsoft 365
sidebar_position: 3
sidebar_label: Microsoft 365
description: Connect Outlook Mail, Outlook Calendar, Outlook Contacts, OneDrive, and Microsoft Teams to AgentHiFive.
---

# Microsoft 365

Connect your Microsoft account to let agents access Outlook Mail, Outlook Calendar, Outlook Contacts, OneDrive, and Microsoft Teams.

## Prerequisites

- A Microsoft 365 account (work, school, or personal)
- OAuth credentials configured in your AgentHiFive instance (see below)

### OAuth Setup (Admin)

If you're self-hosting, you need to register an Azure AD application:

1. Go to [Azure Portal](https://portal.azure.com/) > **App registrations** > **New registration**
2. Name: `AgentHiFive`
3. Supported account types: choose based on your needs (single tenant, multi-tenant, or personal accounts)
4. Redirect URI: `https://your-domain.com/v1/connections/callback` (type: Web)
5. Go to **Certificates & secrets** > **New client secret** and copy the value
6. Go to **API permissions** and add the Microsoft Graph permissions you need
7. Copy credentials to your `.env`:

```env
MICROSOFT_CLIENT_ID=your-application-id
MICROSOFT_CLIENT_SECRET=your-client-secret
MICROSOFT_TENANT_ID=your-tenant-id
```

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Data & Productivity** or **Communication** tab
3. Click the Microsoft service you want (Outlook Mail, Calendar, or Teams)
4. You'll be redirected to Microsoft's login page
5. Sign in and consent to the requested permissions
6. You'll be redirected back with the connection active

:::info Multiple Connections
Microsoft services support **multiple connections** per workspace. Each connection has its own credentials and policies.
:::

## Available Services

| Service ID | Graph API Permissions | Capabilities |
|-----------|----------------------|-------------|
| `microsoft-teams` | `Chat.Read`, `Chat.ReadWrite`, `ChatMessage.Send`, `User.Read`, `Files.Read.All`, `Files.ReadWrite.All`, `offline_access`, `ChannelMessage.Read.All`, `ChannelMessage.Send` | Read/send chat messages, read/share files, manage channels |
| `microsoft-outlook-mail` | `Mail.Read`, `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` | Read and send emails |
| `microsoft-outlook-calendar` | `Calendars.Read`, `Calendars.ReadWrite`, `User.Read`, `offline_access` | Read and create events |
| `microsoft-outlook-contacts` | `Contacts.Read`, `Contacts.ReadWrite`, `User.Read`, `offline_access` | Read and manage contacts |
| `microsoft-onedrive` | `Files.Read`, `Files.ReadWrite`, `User.Read`, `offline_access` | Read, upload, and manage files |

## Vault API Usage

Microsoft uses the Graph API. All endpoints use `https://graph.microsoft.com/v1.0` as the base URL.

### Teams

```
vault_execute({
  service: "microsoft-teams",
  connectionId: "your-connection-id",  // required -- Microsoft supports multiple connections
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/me/chats",
  query: { "$top": "10" }
})
```

### Outlook Contacts

```
vault_execute({
  service: "microsoft-outlook-contacts",
  connectionId: "your-connection-id",
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/me/contacts",
  query: { "$top": "25", "$select": "displayName,emailAddresses,businessPhones" }
})
```

### OneDrive

```
vault_execute({
  service: "microsoft-onedrive",
  connectionId: "your-connection-id",
  method: "GET",
  url: "https://graph.microsoft.com/v1.0/me/drive/root/children",
  query: { "$select": "name,size,lastModifiedDateTime", "$top": "25" }
})
```

:::warning OData Query Syntax
Microsoft Graph uses OData query parameters with `$` prefix: `$top`, `$select`, `$orderby`, `$filter`. Pass these in the `query` parameter.
:::
