---
title: Introduction
sidebar_position: 1
sidebar_label: Introduction
description: What is AgentHiFive, its core concepts, and how authority delegation works for AI agents.
---

# Introduction

AgentHiFive is an **authority delegation and permission control platform for AI agents**. It enables users to grant, constrain, audit, and revoke agent authority over their external services -- without ever handing over long-lived credentials.

**Core Insight:** Users should delegate authority to agents, not hand over credentials.

## What Problem Does AgentHiFive Solve?

AI agents increasingly need access to external services (email, calendars, messaging) to be useful. Today, this typically means sharing passwords or long-lived API tokens directly with agents -- a significant security risk. AgentHiFive sits between agents and providers, enforcing fine-grained policies on every action an agent takes.

## Key Concepts

### Connections

A **Connection** is a link between a user's account on an external provider (Google, Microsoft, Notion, Telegram, Slack, or LLM providers) and the AgentHiFive platform. Connections are created through standard OAuth flows and store encrypted provider tokens in the AgentHiFive vault. Users never share raw credentials with agents.

### Agents

An **Agent** is any AI system that needs to interact with external APIs on a user's behalf. Agents register with AgentHiFive and receive scoped, time-limited access through policy bindings.

### Policies

A **Policy** defines the rules governing what an agent can do with a connection. Policies include allowlists (which API endpoints are permitted), rate limits, time windows, and optional human approval gates. Policies are bound to a specific agent-connection pair.

### Execution Models

AgentHiFive supports two execution models in MVP, with a third on the roadmap:

| Model | How It Works | Credential Exposure | Revocation |
|-------|-------------|---------------------|------------|
| **Model A** (Token Vending) | Agent receives a short-lived access token | Minimal (short TTL) | Stops future token issuance |
| **Model B** (Brokered Proxy) | Agent sends requests through AgentHiFive; platform calls the provider | Zero | Immediate and absolute |
| **Model C** (Roadmap) | Semantic-level proxy with intent validation | Zero | Immediate and absolute |

## Supported Providers

AgentHiFive supports the following provider integrations:

- **Google Workspace** -- Gmail, Calendar, Drive, Sheets, Docs, Contacts
- **Microsoft 365** -- Teams, Outlook Mail, Outlook Calendar, Outlook Contacts, OneDrive
- **Project Management** -- Notion, Trello, Jira
- **Communication** -- Telegram (Bot API), Slack (Bot Token)
- **LLM Providers** -- Anthropic (Claude), OpenAI, Google Gemini, OpenRouter

## Architecture at a Glance

The following diagram shows the request flow from an AI agent through the platform to an external provider:

```
 AI Agent
    |
    | (1) Request with scoped JWT
    v
 AgentHiFive API (Fastify)
    |
    | (2) Verify JWT via JWKS
    | (3) Look up policy binding
    v
 Policy Engine
    |
    | (4) Evaluate guards, allowlists, rate limits
    v
 Execution Gateway
    |
    | (5a) Model A: Vend short-lived token back to agent
    | (5b) Model B: Proxy the call to provider
    v
 Provider API (Google / Microsoft / Notion / Telegram / ...)
```

User authentication is handled separately through the web application (Next.js + Better Auth), which issues short-lived JWTs verified by the API server via a JWKS endpoint.

## Tech Stack Summary

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, Tailwind 4.x, shadcn/ui |
| Backend | Fastify 5.x, Node.js 24 |
| Auth | Better Auth (passkeys, social, email/password) |
| OAuth | oauth4webapi (auth code + device flow) |
| Database | PostgreSQL 15+ |
| Encryption | AES-256-GCM (tokens at rest) |
| Monorepo | pnpm 9.x, Turborepo 2.x, TypeScript 5.7+ |

## Next Steps

- **[Installation & Setup](./installation)** -- Clone the repo, install dependencies, and configure your environment
- **[Quickstart](./quickstart)** -- Walk through the full MVP flow from registration to agent execution
- **[Architecture](/architecture/)** -- Deep dive into system design and module boundaries
- **[API Reference](/api-reference/)** -- Endpoint documentation and schemas
