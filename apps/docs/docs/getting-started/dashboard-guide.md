---
sidebar_position: 6
title: Dashboard Guide
description: Overview of the AgentHiFive web dashboard pages and features
---

# Dashboard Guide

The AgentHiFive web dashboard is where you manage agents, connections, policies, and approvals. This page describes every section of the UI and what you can do in each.

## Navigation

The top navigation bar contains:

- **AgentHiFive** logo link — returns you to the My Agents home page.
- **Requests** — opens the Approvals page. A red badge appears when there are pending approval requests.
- **Activity** — opens the activity timeline.
- **Advanced** dropdown — expands to reveal **Agents**, **Connections**, and **Policies** pages for lower-level management.
- **Documentation** icon — opens the docs site in a new tab.
- **User avatar** — opens a dropdown with your name, email, and links to **Settings**, **Notifications**, **Apps**, **Documentation**, and **Sign out**.

## My Agents (Home)

**Path:** `/dashboard/my-agents`

This is your landing page after login. It shows all agents in your workspace with their connected accounts.

What you can do:

- **View agent cards** — each agent displays its name, description, status badge, and creation date.
- **See connections per agent** — connections are grouped under the agent that has policies for them, showing the service icon, label, provider, status (Healthy / Needs Reconnect / Revoked), and granted scopes.
- **Open connection details** — click a connection to view its full details, including credential preview, metadata, and all policies attached to that agent.
- **Add a policy** — from the connection detail modal, create a new policy that governs how the agent can use that connection (allowed models, default mode, step-up approval rules).
- **Create a new connection for an agent** — open the create-connection modal to link an additional OAuth account to a specific agent.
- **Generate a bootstrap secret** — issue a one-time enrolment key so a new agent instance can register itself. Requires confirmation before generating.
- **See available connections** — connections in your workspace that do not yet have policies for an agent are listed separately so you can attach them.

## Setup Wizard

**Path:** `/dashboard/setup`

The setup wizard runs automatically when you first sign in and have no agents. It creates a default "OpenClaw" agent and walks you through two steps:

1. **Step 1 — AI Provider:** Connect an LLM provider (e.g., OpenAI, Anthropic) so your agent has an AI backend. You provide credentials and the wizard creates the connection.
2. **Step 2 — Connect Accounts:** Link the accounts your agent will operate on, such as Google (Gmail, Calendar) or Microsoft (Outlook, Teams).

After completing both steps, the wizard displays a **one-time enrolment key** (bootstrap secret) that you copy and provide to your OpenClaw instance during its own setup. The key expires in 1 hour.

You can **skip the wizard** at any time using the "Skip setup" button in the top-right corner.

## Approvals

**Path:** `/dashboard/approvals`

This page lists all pending permission requests and step-up approval requests from your agents.

What you can do:

- **Review pending requests** — each request shows the agent name, connection, action being requested, and when it was submitted.
- **Inspect request details** — expand a request to see rich context depending on the action type:
  - **Email actions:** recipient list (to/cc), sender, subject, and body preview.
  - **Calendar events:** event details and attendees.
  - **Telegram messages:** chat ID and message text.
  - **Teams messages:** channel or chat context and body preview.
  - **Slack messages:** channel and message text.
  - **Attachment access:** message subject, sender, attachment name, and file size.
- **View guard triggers** — if a safety guard flagged the request (e.g., prompt injection detection or PII bypass attempt), you can see the rule label, pattern type, matched field, and an excerpt of the flagged content.
- **Approve or deny** — take action on each request. Approvals grant the agent permission to proceed; denials block the action.
- **Handle OAuth consent** — some requests may require you to complete an OAuth popup flow to grant additional scopes before approving.

## Activity

**Path:** `/dashboard/activity`

A chronological timeline of every action taken by agents in your workspace.

What you can do:

- **Browse the event timeline** — events are listed newest-first with timestamps, showing what happened in plain language.
- **Filter by agent** — narrow the view to a specific agent.
- **Filter by connection** — show only events for a particular connected account.
- **Filter by date range** — select start and end dates to scope the timeline.
- **Read event descriptions** — each event is rendered as a human-readable summary (e.g., "OpenClaw obtained access token via google", "OpenClaw executed POST /gmail/v1/users/me/messages/send (200)").
- **See decision badges** — every event displays a colored badge indicating the outcome:
  - **Success** (green) — the action was allowed and completed.
  - **Denied** (red) — the policy engine or an approval blocked the action.
  - **Error** (orange) — the action failed due to an unexpected error.
- **Identify provider** — a provider icon (G for Google, M for Microsoft, T for Telegram) appears next to each event.

Event types include: `token_vended`, `token_vend_denied`, `execution_requested`, `execution_completed`, `execution_denied`, `execution_error`, `rate_limit_exceeded`, `connection_revoked`, `connection_needs_reauth`, and `policy_created`.

## Connections (Advanced)

**Path:** `/dashboard/connections`

A workspace-wide view of all OAuth connections, independent of which agent uses them.

What you can do:

- **Browse available services** — connections are organized by service category (e.g., Email, Calendar, Messaging, AI Providers) using the service catalog.
- **Create a new connection** — select a service, then complete the OAuth popup flow to authorize AgentHiFive to access that account. Singleton services allow only one connection per service.
- **View connection status** — each connection shows one of three statuses:
  - **Healthy** (green) — credentials are valid and working.
  - **Needs Reconnect** (yellow) — the token has expired or been invalidated; click to re-authorize.
  - **Revoked** (red) — the connection was explicitly revoked.
- **See connection metadata** — details vary by provider. For example, Telegram shows bot username; Microsoft shows email, display name, and tenant ID.
- **View attached policies** — see which agents have policies that use this connection and what permissions they grant.
- **Revoke a connection** — permanently disable a connection. Some providers support instant revocation; others are marked as revoked locally.
- **Re-authorize** — for connections in "Needs Reconnect" state, launch the OAuth flow again to refresh credentials.

## Agents (Advanced)

**Path:** `/dashboard/agents`

Direct management of agent registrations in your workspace.

What you can do:

- **List all agents** — see every registered agent with its name, description, icon, status, and creation date.
- **Create a new agent** — fill in a name, optional description, and optional icon URL. After creation, a bootstrap secret is displayed for the agent to use during enrolment.
- **View agent status lifecycle:**
  - **Created** — the agent record exists but has not yet enrolled using its bootstrap secret.
  - **Active** — the agent has enrolled and is operational.
  - **Disabled** — the agent has been manually disabled and cannot make requests.
- **Generate a new bootstrap secret** — if the original secret expired or was lost, generate a replacement. This invalidates any previous unused secret.
- **Disable or enable an agent** — toggle an agent between active and disabled states.
- **Delete an agent** — permanently remove an agent and all its associated policies. Requires confirmation.

## Settings

### Workspace

**Path:** `/dashboard/settings`

General workspace configuration.

What you can do:

- **View workspace ID** — your unique workspace identifier, useful for API integrations.
- **Rename your workspace** — update the display name.
- **View backend version** — see the current build number and date (or "Development" for local builds).
- **Manage API tokens** — programmatic access tokens for the AgentHiFive API:
  - **Create a token** — provide a name and select an expiry period (e.g., 30 days, 90 days, 1 year). The token value is shown once after creation; copy it immediately.
  - **View existing tokens** — see token name, creation date, expiry date, and last-used date.
  - **Revoke a token** — permanently invalidate a token so it can no longer authenticate API requests.

### Notifications

**Path:** `/dashboard/settings/notifications`

Configure where AgentHiFive sends real-time notifications (e.g., when an approval is needed).

What you can do:

- **Set up Telegram notifications** — select a Telegram bot connection, then choose or enter a chat ID. The system can auto-detect recent chats from your bot.
- **Set up Slack notifications** — select a Slack bot connection and specify a channel ID for delivery.
- **Test a channel** — send a test notification to verify the configuration works.
- **Enable or disable channels** — toggle individual notification channels on or off without deleting them.
- **View verification status** — see whether each channel has been successfully verified.

### Apps

**Path:** `/dashboard/settings/apps`

Register your own OAuth applications instead of using the shared AgentHiFive defaults. This is useful for organizations that want full control over their OAuth credentials.

What you can do:

- **Register a Google OAuth app** — provide your Client ID and Client Secret from the Google Cloud Console. A label helps you identify the app.
- **Register a Microsoft OAuth app** — provide your Client ID, Client Secret, and Tenant ID from the Azure portal.
- **View the callback URL** — the redirect URI you need to configure in your OAuth provider's console.
- **See registered apps** — list of all custom OAuth apps with their provider, client ID, label, and registration date.
- **Delete a custom app** — remove a custom OAuth app registration to revert to the shared defaults.

## Notification Bell

The **Requests** link in the top navigation doubles as a notification indicator. When there are pending approval requests (permission requests or step-up approvals), a red badge appears on the link showing the total count. This count refreshes automatically every 30 seconds and updates immediately when you approve or deny a request.

Clicking "Requests" takes you to the Approvals page where you can review and act on all pending items.
