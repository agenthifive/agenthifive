---
title: Quickstart
sidebar_position: 3
sidebar_label: Quickstart
description: End-to-end walkthrough of the AgentHiFive MVP flow, from setup to agent execution.
---

# Quickstart

This guide walks you through the complete AgentHiFive MVP flow: starting the platform, registering a user, creating a connection, setting up an agent with policies, and testing execution.

:::info Prerequisites
Make sure you have completed the [Installation](./installation) guide before proceeding. For **SaaS** users, you need an account at app.agenthifive.com with the OpenClaw plugin installed. For **self-hosted** users, you should have the development environment running with `make up && make dev`.
:::

## Step 1: Start the Development Environment

If your environment is not already running:

```bash
# Start PostgreSQL
make up

# Start both web and API servers
make dev
```

The web UI will be available at **http://localhost:3000** and the API at **http://localhost:4000**.

## Step 2: Register and Log In

Open your browser and navigate to **http://localhost:3000**.

1. Click **Sign Up** to create a new account
2. Register with email and password, or use a social login provider (Google, GitHub)
3. After registration, you will be redirected to the dashboard

![The AgentHiFive dashboard showing your agents and connected apps](/img/getting-started/dashboard-agents.jpg)

:::tip
AgentHiFive supports passkey authentication. After your initial registration, you can add a passkey from your account settings for passwordless login.
:::

## Step 3: Create a Workspace

Workspaces organize your connections, agents, and policies. From the dashboard:

1. Click **Create Workspace**
2. Enter a workspace name (e.g., "My AI Project")
3. Select your desired settings and confirm

All subsequent resources will be scoped to this workspace.

## Step 4: Add a Connection

A connection links your external provider account to AgentHiFive. Navigate to **Connections** in the sidebar:

1. Click **Add Connection**
2. Choose a provider (Google Workspace, Microsoft Teams, or Telegram)
3. Follow the OAuth flow to authorize access

![Add Connection dialog — select a provider and access level](/img/getting-started/add-connection-accounts.jpg)

For this example, we will use Google Workspace:

1. Select **Google Workspace**
2. Click **Authorize** -- you will be redirected to Google's consent screen
3. Grant the requested permissions
4. You will be redirected back to AgentHiFive with the connection active

:::warning
Make sure you have configured the appropriate OAuth credentials (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) in your `.env` file. See the [Installation](./installation) guide for details.
:::

## Step 5: Create an Agent

Agents represent the AI systems that will use your connections. Navigate to **Agents** in the sidebar:

1. Click **Create Agent**
2. Enter a name and description (e.g., "Email Assistant")
3. **Copy the bootstrap secret** -- it is shown only once and expires in 1 hour

![Agents page — register agents and manage bootstrap secrets](/img/getting-started/advanced-agents.jpg)

The agent is now in **Awaiting Bootstrap** status. To activate it, the agent must bootstrap with an ES256 public key:

```typescript
import { AgentHiFiveClient } from "@agenthifive/sdk";
import { generateKeyPair, exportJWK } from "jose";

// Generate an ES256 key pair and bootstrap
const { publicKey, privateKey } = await generateKeyPair("ES256");
const publicJwk = await exportJWK(publicKey);

const result = await AgentHiFiveClient.bootstrap(
  "http://localhost:4000",
  "ah5b_...", // from the dashboard
  publicJwk,
);
```

After bootstrap, the agent status changes to **Active** and the SDK handles token refresh automatically. See the [Agent Authentication](/api-reference/agent-auth) reference for the full protocol details.

## Step 6: Create a Policy Binding

A policy binding connects an agent to a connection with specific rules. Navigate to **Policies** in the sidebar:

1. Click **Create Policy**
2. Select the **agent** (e.g., "Email Assistant")
3. Select the **connection** (e.g., your Google Workspace connection)
4. Choose the **execution model**:
   - **Model A (Token Vending)** -- agent receives short-lived tokens directly
   - **Model B (Brokered Proxy)** -- agent sends requests through AgentHiFive

![Connections page — view granted permissions and authorized agents](/img/getting-started/advanced-connections.jpg)

## Step 7: Configure Guards and Rules

Within the policy, set up fine-grained controls:

- **Allowlisted endpoints** -- which provider API paths the agent may call (e.g., `/gmail/v1/users/me/messages` for read-only email access)
- **Rate limits** -- maximum requests per time window (e.g., 100 requests per hour)
- **Time windows** -- when the agent is allowed to operate (e.g., business hours only)
- **Approval gates** -- require human approval for sensitive operations

These guards are enforced on every request, regardless of execution model.

![Policies page — allowlists, rate limits, and time windows](/img/getting-started/advanced-policies.jpg)

## Step 8: Test Execution via the API

Now test that your agent can call the provider through AgentHiFive.

### Model A: Token Vending

Request a short-lived provider token:

```bash
# Request a scoped access token (use the ah5t_ token from the SDK)
curl -X POST http://localhost:4000/v1/vault/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ah5t_..." \
  -d '{
    "model": "A",
    "connectionId": "conn_xyz789"
  }'
```

Response:

```json
{
  "model": "A",
  "accessToken": "ya29.a0AfH6SM...",
  "tokenType": "Bearer",
  "expiresIn": 3600,
  "auditId": "aud_abc123"
}
```

The agent can then use this short-lived token to call the Google API directly. When the token expires, the agent requests a new one.

### Model B: Brokered Proxy

Send the provider API call through AgentHiFive:

```bash
# Proxy a request through AgentHiFive
curl -X POST http://localhost:4000/v1/vault/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ah5t_..." \
  -d '{
    "model": "B",
    "connectionId": "conn_xyz789",
    "method": "GET",
    "url": "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    "query": {
      "maxResults": "5"
    }
  }'
```

Response:

```json
{
  "model": "B",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": {
    "messages": [
      { "id": "msg_001", "threadId": "thread_001" },
      { "id": "msg_002", "threadId": "thread_002" }
    ]
  },
  "auditId": "aud_def456"
}
```

With Model B, the agent never sees the provider credentials. AgentHiFive makes the call on the agent's behalf and returns the result.

## Step 9: Review the Audit Trail

Every agent action is logged. Navigate to **Audit Log** in the dashboard to see:

- Which agent made the request
- Which connection and provider were used
- The API endpoint called
- Whether the request was allowed or denied
- Timestamp and response status

![Approvals page — review and approve agent data access requests](/img/getting-started/approvals.jpg)

## What You Have Accomplished

By completing this quickstart, you have:

1. Set up the AgentHiFive development environment
2. Created a user account and workspace
3. Established an OAuth connection to an external provider
4. Registered an AI agent
5. Bound the agent to the connection with a policy
6. Configured guards to constrain agent behavior
7. Tested both execution models (token vending and brokered proxy)
8. Reviewed the audit trail for agent actions

## Next Steps

- **[Architecture](/architecture/)** -- Understand the full system design, token model, and module boundaries
- **[API Reference](/api-reference/)** -- Complete endpoint documentation with request/response schemas
- **[Security](/security/)** -- Learn about the encryption model, JWT lifecycle, and threat mitigations
- **[SDK Documentation](/sdk/)** -- Integrate agents programmatically with the TypeScript SDK
