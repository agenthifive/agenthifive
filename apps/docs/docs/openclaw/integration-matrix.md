---
title: Integration Matrix
sidebar_position: 6
sidebar_label: "Integration Matrix"
description: "Complete inventory of OpenClaw's integrations — channels, model providers, plugins, skills, agent tools, and hooks — with transport, auth, and exposure details."
---

# Integration Matrix

OpenClaw connects to external services through six integration categories: **channels** (messaging platforms), **model providers** (LLM APIs), **plugin packages** (npm extensions), **backend skills** (CLI tools), **agent tools** (in-process APIs), and **hooks** (event triggers). This page summarizes every official integration and how credentials flow through the system.

---

## Channels

Channels are messaging platforms that OpenClaw uses to receive and send messages. Each channel has a dedicated adapter that normalizes events into a common format.

| Name | Transport / API | Auth Pattern | How Exposed to Agent |
|---|---|---|---|
| WhatsApp | Baileys / WhatsApp Web | QR pairing session | Agent does not receive raw secrets |
| Telegram | Telegram Bot API (grammy) | Bot token | Agent does not receive raw secrets |
| Discord | Discord Bot API + Gateway | Bot token | Agent does not receive raw secrets |
| Slack | Slack Bolt + API | Bot/app tokens (workspace app) | Agent does not receive raw secrets |
| Feishu (Lark) | Feishu WebSocket event subscription | App credentials | Agent does not receive raw secrets |
| Google Chat | Google Chat API app + webhook | Service account JSON | Agent does not receive raw secrets |
| Mattermost | Mattermost Bot API + WebSocket | Bot token + server URL | Agent does not receive raw secrets |
| Signal | signal-cli bridge | Signal account + signal-cli setup | N/A (local bridge) |
| BlueBubbles | BlueBubbles macOS server REST/WebSocket | Server URL + password | Agent does not receive raw secrets |
| iMessage (legacy) | imsg CLI + Messages DB | macOS local access | N/A (local CLI) |
| Microsoft Teams | Microsoft Bot Framework | Bot app credentials | Agent does not receive raw secrets |
| LINE | LINE Messaging API | Channel access token + secret | Agent does not receive raw secrets |
| Nextcloud Talk | Nextcloud Talk bot webhook | Bot secret + base URL | Agent does not receive raw secrets |
| Matrix | Matrix client-server API | Access token or password login | Agent does not receive raw secrets |
| Nostr | Nostr relays (NIP-04 DMs) | Nostr key material | Agent does not receive raw secrets |
| Tlon (Urbit) | Urbit/Tlon API | Ship URL + login code | Agent does not receive raw secrets |
| Twitch | Twitch IRC | OAuth token | Agent does not receive raw secrets |
| Zalo Bot API | Zalo Bot API | App credentials/token | Agent does not receive raw secrets |
| Zalo Personal | zca-cli / personal account bridge | QR login + local session | Agent does not receive raw secrets |
| WebChat | Gateway WebSocket UI | Gateway auth token/password | Agent does not receive raw secrets |

:::info
All channel credentials are stored in `~/.openclaw/openclaw.json` or environment variables. Agents interact through normalized channel adapters and never see raw tokens or secrets.
:::

---

## Model Providers

Model providers are LLM APIs that OpenClaw routes inference requests through. All providers resolve credentials via a single function: `resolveApiKeyForProvider()`.

### Built-in Providers

| Name | Auth Pattern | Status |
|---|---|---|
| OpenAI | API key | Built-in |
| Anthropic | API key or OAuth | Built-in |
| Google Gemini (API) | API key | Built-in |
| Google Vertex | ADC / gcloud auth | Built-in |
| Groq | API key | Built-in |
| Cerebras | API key | Built-in |
| Mistral | API key | Built-in |
| OpenRouter | API key | Built-in |
| xAI | API key | Built-in |
| Z.AI (GLM) | API key | Built-in |
| Vercel AI Gateway | API key | Built-in |
| OpenCode Zen | API key | Built-in |
| GitHub Copilot | Token | Built-in |
| Ollama | No key (local server) | Built-in local |

### OAuth / Device-Code Providers

| Name | Auth Pattern | Status |
|---|---|---|
| OpenAI Code (Codex) | OAuth login | Built-in |
| Google Antigravity | OAuth login | Built-in + bundled auth plugin |
| Google Gemini CLI | OAuth login | Built-in + bundled auth plugin |
| Qwen Portal | OAuth device-code flow | Bundled auth plugin |

### Custom / Provider-Page Providers

| Name | Auth Pattern | Status |
|---|---|---|
| Moonshot (Kimi) | API key + custom baseUrl | Custom via `models.providers` |
| Kimi Coding | API key + Anthropic-compatible endpoint | Custom via `models.providers` |
| Synthetic | API key + Anthropic-compatible endpoint | Custom via `models.providers` |
| MiniMax | API key | Custom via `models.providers` |
| Amazon Bedrock | AWS auth | Provider docs page |
| Qianfan | Provider auth | Provider docs page |
| Local proxies (LM Studio, vLLM, LiteLLM) | Custom key/baseUrl | Custom via `models.providers` |

:::tip Credential Storage
All model provider credentials are stored in `~/.openclaw/openclaw.json` and/or `~/.openclaw/.env`. OAuth/session tokens may also reside in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.
:::

---

## Plugin Packages

Published npm packages (`@openclaw/*`) that extend OpenClaw with additional channels, tools, or hooks. Each plugin registers its capabilities via the plugin SDK.

| Name | Type | Auth |
|---|---|---|
| `@openclaw/bluebubbles` | Channel plugin | Plugin-specific |
| `@openclaw/discord` | Channel plugin | Plugin-specific |
| `@openclaw/feishu` | Channel plugin | Plugin-specific |
| `@openclaw/msteams` | Channel plugin | Plugin-specific |
| `@openclaw/matrix` | Channel plugin | Plugin-specific |
| `@openclaw/nextcloud-talk` | Channel plugin | Plugin-specific |
| `@openclaw/nostr` | Channel plugin | Plugin-specific |
| `@openclaw/zalo` | Channel plugin | Plugin-specific |
| `@openclaw/zalouser` | Channel plugin | Plugin-specific |
| `@openclaw/voice-call` | Tooling plugin | Plugin-specific |
| `@openclaw/lobster` | Core extension | Plugin-specific |
| `@openclaw/diagnostics-otel` | Ops/observability | Plugin-specific |

:::info
Plugin credentials are stored in `~/.openclaw/openclaw.json` and/or plugin state under `$OPENCLAW_STATE_DIR` (default `~/.openclaw`). Plugins register channels, tools, and hooks -- the agent uses those abstractions rather than accessing credentials directly.
:::

---

## Backend Skills

Skills are CLI tools that the agent invokes via `exec`. Each skill manages its own authentication and credential storage independently of OpenClaw's core credential resolvers.

### Productivity and Workspace

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| Google Workspace (`gog`) | Gmail, Drive, Docs, Sheets, Calendar, People | OAuth2 (managed by gog) | Read+Write |
| Himalaya | IMAP/SMTP protocols | IMAP password/OAuth/keyring | Read+Write |
| Notion | Notion REST API | API token | Read+Write |
| Trello | Trello REST API | API key + token | Read+Write |
| Obsidian | Local filesystem | None (local vault) | Read+Write |
| Bear Notes | macOS Bear app | Local file access | Read+Write |
| Apple Notes | macOS Notes framework | Local access | Read+Write |
| Apple Reminders | macOS Reminders framework | Local access | Read+Write |
| Things 3 | Things URL scheme | Local access | Read |

### Developer Tools

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| GitHub (`gh`) | GitHub REST/GraphQL API | GitHub token (managed by gh) | Read+Write |
| Coding Agent (Codex/Claude/OpenCode) | Multiple LLM APIs | CLI-native auth per agent | Read+Write |
| Oracle (browser control) | OpenAI/Anthropic/Gemini/Grok APIs | CLI-native auth per provider | Read+Write |

### Media and AI

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| OpenAI Whisper | OpenAI Audio API | API key | Read |
| OpenAI Image Gen (DALL-E) | OpenAI Images API | API key | Write |
| Nano Banana Pro | Gemini API | API key | Write |
| Gemini CLI | Gemini API | Interactive auth | Read+Write |
| ElevenLabs TTS (`sag`) | ElevenLabs TTS API | API key | Write |
| GIF Search (`gifgrep`) | Tenor/Giphy APIs | API key | Read |
| Summarize | Multiple model APIs + Firecrawl + Apify | Multiple API keys | Read |

### IoT and Smart Home

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| Philips Hue (`openhue`) | Philips Hue bridge API | Local bridge pairing | Read+Write |
| Sonos | Sonos local network API | None (local) + optional Spotify | Read+Write |
| Eight Sleep (`eightctl`) | Eight Sleep API | Email/password | Read+Write |
| Bluesound (`blucli`) | Bluesound local network API | None (local) | Read+Write |
| Camera Snap (`camsnap`) | RTSP/ONVIF camera protocol | Per-camera URL + credentials | Read |

### Other

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| MCP Server Bridge (`mcporter`) | Any MCP server | Varies per server | Read+Write |
| 1Password | 1Password CLI (`op`) | Desktop app integration | Read |
| Google Places (`goplaces`) | Google Places API v1 | API key | Read |
| Food Delivery (`ordercli`) | Foodora/Deliveroo APIs | Email/password or bearer token | Read+Write |
| RSS/Atom Monitor (`blogwatcher`) | RSS/Atom feeds | None | Read |
| PDF Processing (`nano-pdf`) | Local processing | None | Read |
| Video Frames | Local processing | None | Read |
| Peekaboo (macOS screenshots) | macOS screen capture | macOS local access | Read |
| Canvas | Local display | None | Write |

:::warning Credential Gap
Skills operate **outside** OpenClaw's credential resolver system. CLI tools like `gog` and `himalaya` manage their own OAuth tokens internally. This represents a separate credential surface that requires interception at the skill execution boundary.
:::

---

## Agent Tools

Agent tools are in-process functions that the agent can call directly. Unlike skills (external CLI), these run within the OpenClaw process and use channel credentials.

| Name | API | Operations | Mode |
|---|---|---|---|
| Discord Actions | Discord REST API via discord.js | 42 operations | Read+Write |
| Slack Actions | Slack Web API via @slack/web-api | 12 operations | Read+Write |
| Telegram Actions | Telegram Bot API | 7 operations | Read+Write |
| WhatsApp Actions | WhatsApp Web protocol | 1 operation (reactions) | Write |
| Browser Tool | Web (Playwright/Puppeteer) | Browser automation | Read+Write |
| Web Fetch | HTTP/HTTPS (SSRF-protected) | Web fetching | Read |
| Exec | Local shell | Arbitrary shell execution | Read+Write |

---

## Hooks

Hooks are event triggers that fire based on external events (push notifications, cron schedules, etc.).

| Name | API | Auth Pattern | Mode |
|---|---|---|---|
| Gmail Hooks | Gmail API via `gog` | OAuth2 (managed by gog) | Read |

:::info
Gmail hooks use Pub/Sub push notifications combined with cron scheduling to feed email data to agents.
:::

---

:::tip Download
For the complete dataset with all fields including credential storage paths and source docs:
[Download full CSV](/assets/openclaw_integration_matrix.csv)
:::
