# AgentHiFive

**Authority delegation platform for AI agents.** Connect OAuth provider accounts (Google, Microsoft, Telegram, Slack) and grant AI agents scoped, audited, policy-governed access.

> Users delegate authority to agents, not hand over credentials.

## What is AgentHiFive?

AgentHiFive sits between your AI agents and the services they need to access. Instead of giving agents your passwords or long-lived API keys, you:

1. **Connect** your accounts (Gmail, Calendar, Teams, Slack, etc.) via OAuth
2. **Create policies** that define what an agent can do (allowlists, rate limits, time windows)
3. **Grant access** to specific agents with specific scopes
4. **Monitor** everything through real-time audit logs
5. **Approve or deny** sensitive actions via step-up approval workflow

### Execution Models

- **Model A (Token Vending):** Agent gets a short-lived access token to call the provider directly
- **Model B (Brokered Proxy):** Agent sends requests through AgentHiFive, which makes the call on behalf of the agent with full policy enforcement

## Quick Start

```bash
# Prerequisites
make prereqs          # Install Node.js 24, pnpm, Docker

# Setup
make init             # Install deps, start DB, run migrations

# Development
make dev              # Start web (:3000) + api (:4000)
```

## Self-Hosting

```bash
# Clone and configure
git clone https://github.com/agenthifive/agenthifive.git
cd agenthifive
cp .env.example .env
# Edit .env with your settings (encryption key, OAuth credentials, etc.)

# Start with Docker Compose
docker compose up -d    # Postgres
make init               # Install + migrate
make dev                # Start the platform
```

## Monorepo Structure

```
apps/
  web/              Next.js 16 static SPA (dashboard UI)
  api/              Fastify 5.x backend (auth, vault, policy engine, audit)
  cli/              CLI tool
  docs/             Docusaurus documentation site
packages/
  contracts/        Shared Zod schemas and TypeScript types
  security/         AES-256-GCM encryption utilities
  sdk/              Official TypeScript SDK
  oauth-connectors/ OAuth provider adapters (Google, Microsoft)
  openclaw/         OpenClaw Gateway plugin
  agenthifive-mcp/  MCP server (Model Context Protocol)
integration-testing/  End-to-end tests (Docker Compose)
```

## Tech Stack

- **Runtime:** Node.js 24, TypeScript 5.7+ (strict mode)
- **Frontend:** Next.js 16, React 19, Tailwind 4.x
- **Backend:** Fastify 5.x with typed routes
- **Auth:** Better Auth (sessions + JWT via jose/JWKS)
- **Database:** PostgreSQL 15+ (Drizzle ORM, no raw SQL)
- **Validation:** Zod 4.x
- **OAuth:** oauth4webapi
- **Encryption:** AES-256-GCM

## Supported Integrations

| Category | Providers |
|----------|-----------|
| **Productivity** | Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets, Outlook Mail, Outlook Calendar, OneDrive, Notion, Trello, Jira |
| **Communication** | Slack, MS Teams, Telegram |
| **AI/LLM** | OpenAI, Anthropic, Google Gemini, OpenRouter |

## Agent Integration

### TypeScript SDK

```typescript
import { AgentHiFiveClient } from '@agenthifive/sdk';

const client = new AgentHiFiveClient({ baseUrl: 'https://your-instance.com' });
const result = await client.vault.execute({
  model: 'A',
  connectionId: 'conn-id',
  service: 'gmail',
});
```

### MCP Server

AgentHiFive ships an MCP server for Claude and other MCP-compatible agents:

```bash
npx agenthifive-mcp --base-url https://your-instance.com --token YOUR_TOKEN
```

### OpenClaw Plugin

For [OpenClaw](https://github.com/openclaw/openclaw) users:

```bash
npm install @agenthifive/openclaw
```

## Development

```bash
make dev              # Start all dev servers
make test             # Run test suite (212+ tests)
make lint             # Run linter
make typecheck        # TypeScript checks
make migrate          # Apply DB migrations
make db-reset         # Drop + recreate DB
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

[Apache License 2.0](LICENSE)
