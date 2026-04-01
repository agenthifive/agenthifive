---
title: Jira Cloud
sidebar_position: 12
sidebar_label: Jira Cloud
description: Connect Jira Cloud to AgentHiFive using an API token to let agents search, create, and manage issues, projects, and workflows.
---

# Jira Cloud

Connect Jira Cloud to let agents search, create, update, and manage issues, comments, and projects through the vault.

## Prerequisites

- A Jira Cloud account (Jira Server and Data Center are not supported)
- An Atlassian account email address
- An Atlassian API token

## Creating an API Token

1. Go to [id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens)
2. Click **Create API token**
3. Enter a label for the token (e.g., "AgentHiFive")
4. Click **Create**
5. Copy the token immediately — you won't be able to see it again

:::tip Token Scope
API tokens inherit the permissions of the Atlassian account that created them. To restrict what agents can do, create a dedicated Atlassian account with only the Jira project permissions you want to expose.
:::

## Connecting

1. Go to **Connections** in the dashboard
2. Select the **Data Access** tab
3. Click **Jira Cloud** → **Connect**
4. Enter your **Site URL** (e.g., `mycompany.atlassian.net`)
5. Enter your **Email** (the Atlassian account email associated with the API token)
6. Enter your **API Token** (from the step above)
7. Optionally add a **Label** to identify this connection
8. Click **Connect**

All credentials are stored encrypted per-connection. Each workspace can connect multiple Jira sites.

:::info Token Expiration
Atlassian API tokens do not expire automatically, but you can revoke them at any time from [id.atlassian.com/manage/api-tokens](https://id.atlassian.com/manage/api-tokens). If a token is revoked, the connection will stop working until you update it with a new token.
:::

## Vault API Usage

### Model B (Brokered Proxy)

Jira Cloud connections only support Model B. The vault automatically injects the `Authorization: Basic base64(email:apiToken)` header on every request — do not include authentication yourself.

The base URL is derived from the site URL you configured: `https://{siteUrl}/rest/api/3/`.

```
vault_execute({
  model: "B",
  connectionId: "your-jira-connection-id",
  method: "GET",
  url: "https://mycompany.atlassian.net/rest/api/3/myself"
})
```

:::warning Do Not Include Credentials in Requests
The vault injects the Basic auth header automatically. Never pass `Authorization` headers or embed credentials in your request URL — they will be added by the proxy.
:::

### Example: Search for Open Bugs

```bash
curl -X POST https://yoursite.com/v1/vault/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "B",
    "connectionId": "conn-uuid",
    "method": "GET",
    "url": "https://mycompany.atlassian.net/rest/api/3/search?jql=type%3DBug%20AND%20status%3DOpen"
  }'
```

### Example: Create an Issue

```bash
curl -X POST https://yoursite.com/v1/vault/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "B",
    "connectionId": "conn-uuid",
    "method": "POST",
    "url": "https://mycompany.atlassian.net/rest/api/3/issue",
    "body": {
      "fields": {
        "project": { "key": "PROJ" },
        "summary": "Bug found in checkout flow",
        "issuetype": { "name": "Bug" }
      }
    }
  }'
```

### Example: Add a Comment

```bash
curl -X POST https://yoursite.com/v1/vault/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "B",
    "connectionId": "conn-uuid",
    "method": "POST",
    "url": "https://mycompany.atlassian.net/rest/api/3/issue/PROJ-123/comment",
    "body": {
      "body": {
        "type": "doc",
        "version": 1,
        "content": [
          {
            "type": "paragraph",
            "content": [
              { "type": "text", "text": "Investigating this issue now." }
            ]
          }
        ]
      }
    }
  }'
```

## Available Endpoints

| Method | URL Path | Description |
|--------|----------|-------------|
| GET | `/rest/api/3/myself` | Get current user info |
| GET | `/rest/api/3/search?jql=...` | Search issues with JQL |
| GET | `/rest/api/3/issue/{issueIdOrKey}` | Get issue details |
| POST | `/rest/api/3/issue` | Create a new issue |
| PUT | `/rest/api/3/issue/{issueIdOrKey}` | Update an issue |
| DELETE | `/rest/api/3/issue/{issueIdOrKey}` | Delete an issue |
| GET | `/rest/api/3/issue/{issueIdOrKey}/comment` | Get issue comments |
| POST | `/rest/api/3/issue/{issueIdOrKey}/comment` | Add a comment |
| POST | `/rest/api/3/issue/{issueIdOrKey}/transitions` | Transition issue workflow |
| GET | `/rest/api/3/project` | List all projects |

## Notes

- Jira Cloud uses Basic authentication (`Authorization: Basic base64(email:apiToken)`). The vault handles this automatically using the email and API token stored in the connection.
- Model A (token vending) is not supported — API tokens grant full account access and must not be exposed to the agent.
- The base URL varies per connection since each Jira site has its own subdomain (e.g., `mycompany.atlassian.net`). Always use the site URL you configured when constructing request URLs.
- Jira Cloud uses Atlassian Document Format (ADF) for rich text fields like comments. Simple text-only comments still require the ADF wrapper as shown in the example above.
- JQL queries in the `search` endpoint must be URL-encoded when passed as query parameters.
- To transition an issue (e.g., move from "To Do" to "In Progress"), first call `GET /rest/api/3/issue/{issueIdOrKey}/transitions` to get available transition IDs, then `POST` with the desired `transitionId`.
