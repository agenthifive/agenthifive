# OpenClaw Credential Architecture Analysis

> **Purpose**: Map every official OpenClaw integration point to understand where credentials are stored, how they're accessed, and where a `CredentialProvider` abstraction can be surgically inserted to make AgentHiFive the vault for OpenClaw.
>
> **Date**: 2026-02-09 (analysis), updated April 2026
> **Repo analysed**: github.com/openclaw/openclaw (HEAD as of 2026-02-09)
>
> **Note (April 2026)**: This analysis informed the design of the AgentHiFive plugin. The fork-based approach described in some sections was replaced by a plugin + auto-patch architecture. See [OPENCLAW_TECHNICAL_INTEGRATION.md](./OPENCLAW_TECHNICAL_INTEGRATION.md) for the current implementation. The credential architecture analysis itself remains accurate — the insertion points and credential flows haven't changed in OpenClaw.

---

## 1. Executive Summary

OpenClaw handles ~52 official integration points (20 channels, 27+ model providers, 5 plugin-config integrations) with **no centralized credential abstraction**. Credentials are stored in plaintext across three locations (`openclaw.json`, `auth-profiles.json`, session files) and accessed via direct property reads.

However, the access patterns converge on **3 main insertion points** that, if modified, would cover **all 49 credential-bearing integrations**:

| Insertion Point | Integrations Covered | Difficulty |
|---|---|---|
| **IP-2**: Core channel resolvers (plugin-sdk re-exports) | 7 core channels | Low (single SDK) |
| **IP-2b**: Extension-local resolvers | 12 extension channels | Medium (12 functions, same pattern) |
| **IP-3**: `resolveApiKeyForProvider()` | All 27+ model providers | Low (single async function) |

---

## 2. Current Credential Storage Layers

### Layer 1: `~/.openclaw/openclaw.json` (inline in config)

- Format: JSON5
- Loaded by: `loadConfig()` in `src/config/io.ts`
- Caching: 200ms in-memory (configurable via `OPENCLAW_CONFIG_CACHE_MS`)
- Contains: Channel tokens, model provider API keys, gateway auth, plugin config
- Channel credentials stored at: `channels.<provider>.<field>`
- Model provider keys stored at: `models.providers.<provider>.apiKey`
- Supports `${ENV_VAR}` substitution at load time
- Supports `tokenFile` / `secretFile` indirection (reads file at resolution time)

### Layer 2: `~/.openclaw/auth-profiles.json` (model provider keys)

- Format: JSON
- Loaded by: `loadAuthProfileStore()` in `src/agents/auth-profiles/store.ts`
- File permissions: `0o600` (owner only)
- Atomic updates via `proper-lockfile`
- Structure:
  ```typescript
  {
    version: number;
    profiles: Record<string, ApiKeyCredential | TokenCredential | OAuthCredential>;
    order?: Record<string, string[]>;       // provider → preferred profile order
    lastGood?: Record<string, string>;      // provider → last successful profile
    usageStats?: Record<string, ProfileUsageStats>; // round-robin tracking
  }
  ```
- Credential types:
  - `api_key`: `{ type: "api_key", provider, key, email?, metadata? }`
  - `token`: `{ type: "token", provider, token, expires?, email? }`
  - `oauth`: `{ type: "oauth", provider, access, refresh, expires, email?, clientId? }`

### Layer 3: File-based sessions (WhatsApp, Matrix)

- WhatsApp: `~/.openclaw/oauth/whatsapp/{accountId}/creds.json` (Baileys multi-file auth state)
- Matrix: `<stateDir>/credentials/matrix/credentials.json` (extension-managed)
- Signal: Local `signal-cli` daemon (no managed credentials)
- iMessage: Local `imsg` binary (macOS system auth)

---

## 3. Channel Integration Map (20 channels)

### 3.1 Core Channels — Plugin-SDK Resolvers (Insertion Point 2)

These 7 channels have their credential resolvers in `src/` and are re-exported via `openclaw/plugin-sdk`. A single change to the SDK covers all of them.

| Channel | Resolver Function | File | Sync/Async | Credential Type | Config Properties |
|---|---|---|---|---|---|
| **telegram** | `resolveTelegramToken()` | `src/telegram/token.ts` | sync | Bot token | `channels.telegram.botToken`, `.tokenFile`, `.accounts.{id}.botToken`, env `TELEGRAM_BOT_TOKEN` |
| **discord** | `resolveDiscordToken()` | `src/discord/token.ts` | sync | Bot token | `channels.discord.token`, `.accounts.{id}.token`, env `DISCORD_BOT_TOKEN` |
| **slack** | `resolveSlackAccount()` | `src/slack/accounts.ts` | sync | Bot token + App token | `channels.slack.botToken`, `.appToken`, `.accounts.{id}.*`, env `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` |
| **line** | `resolveLineAccount()` | `src/line/accounts.ts` | sync | Access token + Secret | `channels.line.channelAccessToken`, `.channelSecret`, `.tokenFile`, `.secretFile`, env `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` |
| **whatsapp** | `resolveWhatsAppAccount()` | `src/web/accounts.ts` | **async** | Baileys session (creds.json) | `channels.whatsapp.accounts.{id}.authDir` or `$OPENCLAW_OAUTH_DIR/whatsapp/{id}/` |
| **signal** | `resolveSignalAccount()` | `src/signal/accounts.ts` | sync | Local RPC URL (no secret) | `channels.signal.httpUrl`, `.httpHost`, `.httpPort` |
| **imessage** | `resolveIMessageAccount()` | `src/imessage/accounts.ts` | sync | CLI path (no secret) | `channels.imessage.cliPath`, `.dbPath` |

**Resolution priority** (common to all): account-specific config → base config → tokenFile → env var (default account only).

**Note**: "webchat" is not a separate channel — it's the WhatsApp Web/Gateway WebSocket UI, using `cfg.gateway.auth.token/password`.

### 3.2 Extension Channels — Local Resolvers (Insertion Point 2b)

These 12 channels each define their own credential resolver within the extension. They all follow the same pattern (read `cfg.channels.{name}.*` + env fallback) but are not centralized.

| Channel | Resolver Function | File | Sync/Async | Credential Type | Config Properties |
|---|---|---|---|---|---|
| **msteams** | `resolveMSTeamsCredentials()` | `extensions/msteams/src/token.ts` | sync | AppId + AppPassword + TenantId | `channels.msteams.appId`, `.appPassword`, `.tenantId`, env `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID` |
| **mattermost** | `resolveMattermostAccount()` | `extensions/mattermost/src/mattermost/accounts.ts` | sync | Bot token + BaseURL | `channels.mattermost.botToken`, `.baseUrl`, env `MATTERMOST_BOT_TOKEN`, `MATTERMOST_URL` |
| **feishu** | `resolveFeishuCredentials()` | `extensions/feishu/src/accounts.ts` | sync | AppId + AppSecret | `channels.feishu.appId`, `.appSecret`, `.encryptKey`, `.verificationToken` |
| **googlechat** | `resolveCredentialsFromConfig()` + `getGoogleChatAccessToken()` | `extensions/googlechat/src/accounts.ts` + `src/auth.ts` | **async** | Service account JSON → OAuth2 | `channels.googlechat.serviceAccount`, `.serviceAccountFile`, env `GOOGLE_CHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` |
| **twitch** | `resolveTwitchToken()` | `extensions/twitch/src/token.ts` | sync | OAuth access token | `channels.twitch.accessToken`, env `OPENCLAW_TWITCH_ACCESS_TOKEN` |
| **zalo** | `resolveZaloToken()` | `extensions/zalo/src/token.ts` | sync | Bot token | `channels.zalo.botToken`, `.tokenFile`, env `ZALO_BOT_TOKEN` |
| **zalouser** | `resolveZalouserAccount()` | `extensions/zalouser/src/accounts.ts` | **async** | External CLI session | `channels.zalouser.profile`, env `ZCA_PROFILE` |
| **nextcloud-talk** | `resolveNextcloudTalkSecret()` | `extensions/nextcloud-talk/src/accounts.ts` | sync | HMAC shared secret | `channels.nextcloud-talk.botSecret`, `.botSecretFile`, `.baseUrl`, env `NEXTCLOUD_TALK_BOT_SECRET` |
| **matrix** | `resolveMatrixAuth()` + file credential cache | `extensions/matrix/src/matrix/client/config.ts` + `src/matrix/credentials.ts` | **async** | Access token or password → session | `channels.matrix.homeserver`, `.userId`, `.accessToken`, `.password`, env `MATRIX_*` + file `credentials/matrix/credentials.json` |
| **nostr** | `resolveNostrAccount()` | `extensions/nostr/src/types.ts` | sync | Private key (hex/nsec) | `channels.nostr.privateKey` |
| **tlon** | `resolveTlonAccount()` + `authenticate()` | `extensions/tlon/src/types.ts` + `src/urbit/auth.ts` | **async** | Ship URL + code → session cookie | `channels.tlon.ship`, `.url`, `.code` |
| **bluebubbles** | `resolveBlueBubblesAccount()` | `extensions/bluebubbles/src/accounts.ts` | sync | Server URL + password | `channels.bluebubbles.serverUrl`, `.password` |

---

## 4. Model Provider Map (27+ providers)

**ALL model providers** resolve through a single function: `resolveApiKeyForProvider()` in `src/agents/model-auth.ts` (Insertion Point 3).

### 4.1 Resolution Tier Order

1. **Tier 0 — Explicit Profile**: If `profileId` passed directly, resolve that exact profile
2. **Tier 1 — Auth Override (aws-sdk)**: If `providers[x].auth === "aws-sdk"`, use AWS SDK chain
3. **Tier 2 — Auth Profile Order**: Iterate through profiles (config order → stored order → round-robin with cooldown)
4. **Tier 3 — Env Var**: Provider-specific environment variable lookup
5. **Tier 4 — Custom Config Key**: `models.providers[provider].apiKey` from config
6. **Tier 5 — Implicit AWS fallback**: For `amazon-bedrock` only
7. **Error**: Throw with diagnostic message

### 4.2 Built-in Providers (API key via env var)

| Provider | Env Var | Auth Mode |
|---|---|---|
| openai | `OPENAI_API_KEY` | api_key |
| anthropic | `ANTHROPIC_OAUTH_TOKEN` > `ANTHROPIC_API_KEY` | api_key or oauth |
| google (Gemini) | `GEMINI_API_KEY` | api_key |
| groq | `GROQ_API_KEY` | api_key |
| cerebras | `CEREBRAS_API_KEY` | api_key |
| mistral | `MISTRAL_API_KEY` | api_key |
| openrouter | `OPENROUTER_API_KEY` | api_key |
| xai | `XAI_API_KEY` | api_key |
| zai | `ZAI_API_KEY` > `Z_AI_API_KEY` | api_key |
| vercel-ai-gateway | `AI_GATEWAY_API_KEY` | api_key |
| opencode | `OPENCODE_API_KEY` > `OPENCODE_ZEN_API_KEY` | api_key |
| kimi-coding | `KIMI_API_KEY` > `KIMICODE_API_KEY` | api_key |
| moonshot | `MOONSHOT_API_KEY` | api_key |
| minimax (API) | `MINIMAX_API_KEY` | api_key |
| synthetic | `SYNTHETIC_API_KEY` | api_key |
| venice | `VENICE_API_KEY` | api_key |
| xiaomi | `XIAOMI_API_KEY` | api_key |
| qianfan | `QIANFAN_API_KEY` | api_key |
| cloudflare-ai-gateway | `CLOUDFLARE_AI_GATEWAY_API_KEY` | api_key (+ metadata) |
| ollama | `OLLAMA_API_KEY` | api_key (placeholder, local) |

### 4.3 OAuth Providers (refresh token flow)

| Provider | Auth Mode | Refresh Handler | Special Flow |
|---|---|---|---|
| openai-codex | oauth | pi-ai upstream `getOAuthApiKey` | ChatGPT OAuth flow |
| anthropic (oauth mode) | oauth | pi-ai upstream `getOAuthApiKey` | Claude CLI credential import |
| google-antigravity | oauth (PKCE) | pi-ai upstream `getOAuthApiKey` | Localhost callback, apiKey = `JSON.stringify({token, projectId})` |
| google-gemini-cli | oauth (PKCE) | pi-ai upstream `getOAuthApiKey` | Extracts client creds from Gemini CLI binary |
| qwen-portal | oauth (device_code) | custom `refreshQwenPortalCredentials()` | Device code flow |
| minimax-portal | oauth (device_code) | pi-ai upstream | Device code flow |
| chutes | oauth (PKCE) | custom `refreshChutesTokens()` | Custom PKCE flow |

### 4.4 Special Auth Flows

| Provider | Auth Mode | Mechanism |
|---|---|---|
| github-copilot | token | PAT exchanged for Copilot token via GitHub API |
| google-vertex | gcloud ADC | Application Default Credentials |
| amazon-bedrock | aws-sdk | AWS SigV4 signing via SDK credential chain |
| copilot-proxy | token (placeholder) | Local proxy, no real auth |

### 4.5 Not Distinct Providers

| Listed Name | Actual Status |
|---|---|
| glm-models | Not a provider. GLM models served via `opencode`, `synthetic`, `venice` |
| minimax-cloud | Auth choice alias for `minimax` (API key flavor) |
| lmstudio / vllm / litellm | No explicit integration. Use custom `models.providers` config |

---

## 5. Plugin-Config Integrations (5 extensions)

These extensions read credentials from `api.pluginConfig` rather than channel config:

| Extension | Credential Concern | Config Path |
|---|---|---|
| **voice-call** | Twilio/Telnyx/Plivo API keys | `pluginConfig.twilio.accountSid`, `.authToken`, `pluginConfig.telnyx.apiKey`, etc. + env vars |
| **memory-lancedb** | OpenAI embedding API key | `pluginConfig.embedding.apiKey` |
| **device-pair** | Gateway auth token | `config.gateway.auth.token/password` + env vars |
| **llm-task** | Delegates to core runtime | `pluginConfig.defaultProvider` (no direct credential access) |
| **lobster** | Binary path only | `pluginConfig.lobsterPath` (no credentials) |

---

## 6. Skill-Based Integrations (CLI Tools Invoked by Agent)

Beyond channels (messaging) and model providers (LLM inference), OpenClaw agents access external services through **skills** — CLI tools invoked via the `exec` tool or dedicated skill runners. These represent a **separate data access surface** not covered by the channel/provider insertion points.

### 6.1 Google Workspace — `gog` CLI

**Location**: `skills/gog/`
**Credential**: OAuth2 (Google account), managed by `gog` internally
**External repo**: Separate CLI tool, not part of OpenClaw core

| Capability | Command | API | Read/Write |
|---|---|---|---|
| **Gmail search** | `gog gmail search 'newer_than:7d'` | Gmail API | Read |
| **Gmail message read** | `gog gmail messages search "in:inbox"` | Gmail API | Read |
| **Gmail send** | `gog gmail send --to a@b.com` | Gmail API | Write |
| **Gmail reply** | `gog gmail reply --reply-to-message-id <id>` | Gmail API | Write |
| **Gmail watch** | `gog gmail watch start` + `gog gmail watch serve` | Gmail + Pub/Sub | Read (push) |
| **Gmail history** | `gog gmail history --since <historyId>` | Gmail API | Read |
| **Google Drive search** | `gog drive search "budget"` | Drive API | Read |
| **Google Docs export** | `gog docs export <docId> --format txt` | Docs API | Read |
| **Google Sheets read** | `gog sheets read <sheetId>` | Sheets API | Read |
| **Google Sheets update** | `gog sheets update <sheetId>` | Sheets API | Write |
| **Google Calendar list** | `gog calendar list` | Calendar API | Read |
| **Google Calendar create** | `gog calendar create` | Calendar API | Write |
| **Google Contacts** | `gog contacts list` | People API | Read |

**Gmail Pub/Sub push integration** (built into OpenClaw core):
- Files: `src/hooks/gmail-ops.ts`, `src/hooks/gmail-watcher.ts`, `src/hooks/gmail.ts`
- Template in `src/gateway/hooks-mapping.ts` feeds email body to agents:
  `"New email from {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].body}}"`
- Combined with cron: `openclaw cron add --name "Morning brief" --cron "0 7 * * *" --message "Summarize overnight emails"`

**Risk**: Agent has full read+write access to Gmail, Drive, Docs, Sheets, Calendar via a single OAuth credential managed by `gog`.

### 6.2 Email — Himalaya (IMAP/SMTP)

**Location**: `skills/himalaya/`
**Credential**: IMAP password, OAuth2, or system keyring
**External repo**: Separate CLI tool (`himalaya-cli/himalaya`)

| Capability | Command | Protocol | Read/Write |
|---|---|---|---|
| **List inbox** | `himalaya envelope list` | IMAP | Read |
| **Search emails** | `himalaya envelope list from john@example.com subject meeting` | IMAP | Read |
| **Read email** | `himalaya message read <messageId>` | IMAP | Read |
| **Download attachments** | `himalaya attachment download <messageId>` | IMAP | Read |
| **Send email** | `himalaya message send` | SMTP | Write |
| **Reply/forward** | `himalaya message reply <messageId>` | SMTP | Write |
| **Move/delete** | `himalaya message move/delete <messageId>` | IMAP | Write |

**Risk**: Full IMAP access to any configured email account. Works with Gmail, iCloud, generic IMAP.

### 6.3 Feishu (Lark) Cloud Storage Suite

**Location**: `extensions/feishu/skills/`
**Credential**: Feishu appId + appSecret (same as channel credential)

| Skill | Capabilities | Read/Write |
|---|---|---|
| **feishu-drive** | List folders, get file info, create folders, move/delete files | Read+Write |
| **feishu-doc** | Read/write/append document content, manage blocks | Read+Write |
| **feishu-wiki** | List knowledge spaces, navigate/create/rename/move nodes | Read+Write |
| **feishu-perm** | List/add/remove collaborators on any document or folder | **Admin** |

**Risk**: Full CRUD on Feishu cloud storage, documents, wiki, and permission management. Permission skill disabled by default due to sensitivity.

### 6.4 Notion

**Location**: `skills/notion/`
**Credential**: Notion API token (via env or config)

| Capability | Read/Write |
|---|---|
| Create/read/update pages | Read+Write |
| Query databases | Read |
| Create/update blocks | Read+Write |
| Search pages and databases | Read |

### 6.5 Local File Systems

| Skill | Location | What It Accesses |
|---|---|---|
| **Obsidian** | `skills/obsidian/` | Local vault directories (markdown files + attachments) |
| **Bear Notes** | `skills/bear-notes/` | macOS Bear app (API token) |
| **exec tool** | `src/agents/tools/exec.ts` | Arbitrary shell commands, full filesystem access |
| **Browser tool** | `src/agents/tools/browser-tool.ts` | File download/upload via browser |

### 6.6 Other Skills with External API Access

| Skill | API | Credential |
|---|---|---|
| **Google Places** (`skills/goplaces/`, `skills/local-places/`) | Places API v1 | `GOOGLE_PLACES_API_KEY` |
| **mcporter** (MCP server bridge) | Any MCP server | Varies per server |
| **summarize** | Various (URLs, files) | None (uses fetch) |

### 6.7 Skill Credential Architecture

Skills operate **outside** the channel/model provider credential system:

```
Channel credentials    → resolveXxxToken() → config/env     → IP-2, IP-2b
Model provider keys    → resolveApiKeyForProvider() → auth-profiles → IP-3
Skill credentials      → CLI tool's own auth system → NOT INTERCEPTABLE by IP-2/3
```

**This is a gap.** The `gog` CLI manages its own OAuth tokens internally. Himalaya manages its own IMAP credentials. These bypass all of OpenClaw's credential resolvers. Intercepting them requires either:
1. **Forking the CLI tool** (e.g., "vault-gog" that delegates to AgentHiFive)
2. **Wrapping the exec invocation** (intercept the shell command before it runs)
3. **Replacing the skill** with an AgentHiFive-native MCP tool

---

## 7. No Credential Access (6 extensions)

| Extension | Notes |
|---|---|
| memory-core | Delegates to runtime |
| diagnostics-otel | Standard OTEL env vars handled by SDK |
| open-prose | Empty register function |
| phone-control | No external credentials |
| talk-voice | Reads `cfg.talk.apiKey` (ElevenLabs, operational config) |

---

## 8. Insertion Point Analysis

### IP-1: `loadConfig()` in `src/config/io.ts`

- **What**: The single entry point for loading `openclaw.json`
- **Impact**: All consumers get vault-backed credentials transparently
- **Difficulty**: Low (single function)
- **Risk**: Currently **synchronous**, called ~50 places. Converting to async ripples everywhere.
- **Verdict**: Too invasive for MVP. Consider for v2.

### IP-2: Core channel resolvers in `src/` (re-exported via plugin-sdk)

- **What**: 7 functions: `resolveTelegramToken()`, `resolveDiscordToken()`, `resolveSlackAccount()`, `resolveLineAccount()`, `resolveWhatsAppAccount()`, `resolveSignalAccount()`, `resolveIMessageAccount()`
- **Impact**: All 7 core channels flow through vault
- **Difficulty**: Low-medium. Most are sync today; need async conversion.
- **Files to modify**: `src/telegram/token.ts`, `src/discord/token.ts`, `src/slack/accounts.ts`, `src/line/accounts.ts`, `src/web/accounts.ts`, `src/signal/accounts.ts`, `src/imessage/accounts.ts`
- **Sync→Async concern**: WhatsApp is already async. The other 6 are sync. Converting them requires updating all callers. This is the biggest refactor risk.

### IP-2b: Extension-local resolvers

- **What**: 12 functions, one per extension channel
- **Impact**: All extension channels flow through vault
- **Difficulty**: Medium. Each extension has its own resolver, but they all follow the same pattern.
- **Approach**: Introduce a shared `resolveChannelCredential()` helper in plugin-sdk that extensions call instead of reading config directly. Extensions gradually migrate.

### IP-3: `resolveApiKeyForProvider()` in `src/agents/model-auth.ts`

- **What**: Single function with 6-tier fallback chain
- **Impact**: ALL 27+ model providers flow through vault
- **Difficulty**: **Low**. Already async. Already has the right shape for adding a Tier 0: "ask vault first".
- **Files to modify**: `src/agents/model-auth.ts` (add vault tier), `src/agents/auth-profiles/store.ts` (vault-backed store)
- **This is the cleanest insertion point in the entire codebase.**

### IP-4: Auth Profile Store in `src/agents/auth-profiles/store.ts`

- **What**: `loadAuthProfileStore()` / `ensureAuthProfileStore()` / `saveAuthProfileStore()`
- **Impact**: OAuth refresh tokens and API keys stored in vault instead of local JSON
- **Difficulty**: Medium. Lock-based atomic updates need vault-side equivalent.
- **Subset of IP-3**: Modifying the store is optional if IP-3 already adds vault as Tier 0.

### IP-5: Plugin API creation in `src/plugins/registry.ts`

- **What**: Where `OpenClawPluginApi` is constructed and `config` is passed to plugins
- **Impact**: New plugins can use vault credentials via a dedicated accessor
- **Difficulty**: Low (additive, non-breaking)
- **Risk**: Existing plugins that read `api.config.channels.*` directly won't be intercepted

---

## 9. Coverage Matrix

### 9.1 Channel + Model Provider Coverage (IP-2, IP-2b, IP-3)

| Insertion Point | Channels | Model Providers | Plugin-Config | Total |
|---|---|---|---|---|
| IP-2 (core resolvers) | 7 | — | — | 7 |
| IP-2b (extension resolvers) | 12 | — | — | 12 |
| IP-3 (resolveApiKeyForProvider) | — | 27 | — | 27 |
| IP-5 (plugin API) | — | — | 3 | 3 |
| No change needed | — | — | — | 6 |
| **Total** | **19** | **27** | **3** | **49** |

Signal and iMessage are listed in channels but have no external credentials (local RPC/CLI). They're covered by IP-2 structurally but don't need vault integration.

### 9.2 Skill-Based Data Access Surface (NOT covered by IP-2/3)

These integrations bypass OpenClaw's credential resolvers entirely — the CLI tools manage their own auth:

| Skill | External Service | Credential Type | Data Risk | Interceptable via IP-2/3? |
|---|---|---|---|---|
| **gog** | Gmail, Drive, Docs, Sheets, Calendar, Contacts | OAuth2 (managed by gog) | **Critical** — full Workspace read+write | **No** |
| **himalaya** | Any IMAP/SMTP server | Password/OAuth/keyring (managed by himalaya) | **Critical** — full email read+write+delete | **No** |
| **feishu-drive/doc/wiki/perm** | Feishu Cloud | appId+appSecret (from channel config) | **High** — full cloud storage CRUD + permissions | Partially (shares channel credential) |
| **notion** | Notion API | API token (env/config) | **Medium** — workspace CRUD | **No** |
| **obsidian** | Local filesystem | None (local) | **Medium** — vault file access | N/A |
| **goplaces / local-places** | Google Places API | API key (env) | **Low** — read-only location data | **No** |
| **mcporter** | Any MCP server | Varies | **Unknown** — depends on MCP server | **No** |
| **exec tool** | Local shell | None (local) | **High** — arbitrary command execution | N/A |

### 9.3 New Insertion Point: IP-6 — Skill/CLI Credential Interception

The skill-based integrations represent a **separate credential surface** that requires different interception strategies:

| Strategy | Scope | Difficulty | Notes |
|---|---|---|---|
| **Fork the CLI tool** (e.g., "vault-gog") | Per-tool | Medium | Replace CLI's internal auth with AgentHiFive vault delegation |
| **Wrap exec invocation** | All skills | Hard | Intercept shell commands, rewrite credential env vars |
| **Replace skill with MCP tool** | Per-tool | Medium | Build AgentHiFive-native MCP server for Gmail/Drive/etc. |
| **Credential env injection** | API-key skills | Easy | Inject vault-resolved keys as env vars before skill execution |

---

## 10. Recommended Phased Approach

### Phase 1: Model Providers (IP-3) — Lowest effort, highest value

Modify `resolveApiKeyForProvider()` to check AgentHiFive vault as **Tier 0** before the existing fallback chain. If the vault returns a credential, use it. Otherwise, fall through to existing behavior.

- **1 file changed**: `src/agents/model-auth.ts`
- **Non-breaking**: Existing behavior preserved when vault is not configured
- **Covers**: All 27+ model providers immediately

### Phase 2: Core Channels (IP-2) — Medium effort

Add vault delegation to the 7 core channel resolvers. The sync→async conversion is the main challenge.

- **7 files changed**: One per core channel in `src/`
- **Breaking**: Callers of sync resolvers must handle async
- **Covers**: Telegram, Discord, Slack, LINE, WhatsApp, Signal, iMessage

### Phase 3: Extension Channels (IP-2b) — Medium effort, parallelizable

Introduce a shared `resolveChannelCredential()` helper. Migrate extension resolvers one by one.

- **12 extensions modified**: Each gets a small change to delegate to the helper
- **Non-breaking per extension**: Can be done incrementally
- **Covers**: All remaining channels

### Phase 4: Auth Profile Store (IP-4) — Optional

Replace the local `auth-profiles.json` file store with a vault-backed implementation. This means OAuth refresh tokens never touch disk.

- **1-2 files changed**: `src/agents/auth-profiles/store.ts`
- **Covers**: All OAuth providers (Google, Qwen, MiniMax, Chutes, Codex)

### Phase 5: Skill-Based Integrations (IP-6) — Separate track

Skill CLI tools (`gog`, `himalaya`) manage their own credentials outside OpenClaw's resolver system. Three strategies (can be pursued in parallel):

- **Fork `gog`** ("vault-gog"): Replace internal OAuth with AgentHiFive vault delegation + API proxying. Covers Gmail, Drive, Docs, Sheets, Calendar.
- **Credential env injection**: For API-key-based skills (Google Places, etc.), inject vault-resolved keys as env vars before skill execution.
- **Replace with MCP tools**: Build AgentHiFive-native MCP servers for Gmail/Drive that agents use instead of CLI skills.

---

## 11. Key Technical Risks

### Sync→Async Conversion (IP-2)

Most channel token resolvers are synchronous. Converting to async requires updating every call site. Grep for `resolveTelegramToken(`, `resolveDiscordToken(`, etc. to assess blast radius before starting.

### Config Caching (IP-1, IP-3)

`loadConfig()` has 200ms caching. If vault calls are added at the config level, they'd fire on every cache miss. Consider credential-level caching with longer TTL.

### Offline / Vault-Unreachable Fallback

If the AgentHiFive vault is unreachable, the system must fall through to local credentials gracefully. The existing fallback chain in `resolveApiKeyForProvider()` naturally supports this — vault becomes just another tier that can return nothing.

### OAuth Token Refresh Atomicity

The current refresh flow uses `proper-lockfile` for atomic file updates. A vault-backed store needs equivalent atomicity (compare-and-swap or similar).

---

## Appendix A: Key Source Files

| File | Purpose |
|---|---|
| `src/config/io.ts` | Config loading pipeline, `loadConfig()` |
| `src/config/types.openclaw.ts` | Root `OpenClawConfig` type |
| `src/config/types.telegram.ts` | Telegram config schema (180 lines) |
| `src/config/types.discord.ts` | Discord config schema (168 lines) |
| `src/config/types.slack.ts` | Slack config schema (152 lines) |
| `src/config/types.models.ts` | Model provider config types |
| `src/config/env-substitution.ts` | `${VAR}` substitution at load time |
| `src/agents/model-auth.ts` | `resolveApiKeyForProvider()` — 6-tier resolution (399 lines) |
| `src/agents/auth-profiles/types.ts` | Auth profile credential types |
| `src/agents/auth-profiles/store.ts` | Auth profile storage/loading (379 lines) |
| `src/agents/auth-profiles/oauth.ts` | OAuth refresh routing |
| `src/telegram/token.ts` | `resolveTelegramToken()` |
| `src/discord/token.ts` | `resolveDiscordToken()` |
| `src/slack/accounts.ts` | `resolveSlackAccount()` |
| `src/line/accounts.ts` | `resolveLineAccount()` |
| `src/web/accounts.ts` | `resolveWhatsAppAccount()` |
| `src/plugins/registry.ts` | Plugin API creation (`createApi()`) |
| `src/plugins/types.ts` | `OpenClawPluginApi` interface |
| `src/plugin-sdk/index.ts` | Public SDK exports (390 lines) |
| `src/hooks/gmail-ops.ts` | Gmail Pub/Sub setup operations |
| `src/hooks/gmail-watcher.ts` | Gmail watch service |
| `src/hooks/gmail.ts` | Gmail configuration utilities |
| `src/gateway/hooks-mapping.ts` | Gmail webhook template + mapping |
| `skills/gog/SKILL.md` | Google Workspace CLI skill definition |
| `skills/himalaya/SKILL.md` | IMAP/SMTP email client skill definition |
| `extensions/feishu/skills/` | Feishu Drive/Doc/Wiki/Perm skills |
| `skills/notion/` | Notion API skill |
| `src/discord/api.ts` | `fetchDiscord()` — single HTTP client for all Discord API calls |
| `src/slack/client.ts` | `createSlackWebClient()` — single factory for Slack WebClient instances |
| `src/slack/actions.ts` | 14 Slack operation handlers (react, send, edit, delete, pin, etc.) |
| `src/slack/send.ts` | `sendMessageSlack()` — outbound message + file handler |
| `src/agents/tools/slack-actions.ts` | Slack agent tool dispatcher (12 operations) |
| `src/slack/directory-live.ts` | Slack directory lookups (`users.list`, `conversations.list`) |
| `extensions/msteams/src/graph-upload.ts` | MS Teams Graph API calls (OneDrive/SharePoint) |
| `extensions/msteams/src/attachments/graph.ts` | MS Teams Graph API calls (message/attachment access) |
| `extensions/msteams/src/directory-live.ts` | MS Teams Graph API calls (user/team directory) |

## Appendix B: Environment Variables for Credentials

### Channel Credentials
```
TELEGRAM_BOT_TOKEN
DISCORD_BOT_TOKEN
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
LINE_CHANNEL_ACCESS_TOKEN
LINE_CHANNEL_SECRET
MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID
MATTERMOST_BOT_TOKEN / MATTERMOST_URL
GOOGLE_CHAT_SERVICE_ACCOUNT / GOOGLE_CHAT_SERVICE_ACCOUNT_FILE
OPENCLAW_TWITCH_ACCESS_TOKEN
ZALO_BOT_TOKEN
ZCA_PROFILE
NEXTCLOUD_TALK_BOT_SECRET
MATRIX_HOMESERVER / MATRIX_USER_ID / MATRIX_ACCESS_TOKEN / MATRIX_PASSWORD / MATRIX_DEVICE_NAME
OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD
```

### Model Provider Credentials
```
OPENAI_API_KEY
ANTHROPIC_API_KEY / ANTHROPIC_OAUTH_TOKEN
GEMINI_API_KEY
GROQ_API_KEY
CEREBRAS_API_KEY
MISTRAL_API_KEY
OPENROUTER_API_KEY
XAI_API_KEY
ZAI_API_KEY / Z_AI_API_KEY
AI_GATEWAY_API_KEY (Vercel)
OPENCODE_API_KEY / OPENCODE_ZEN_API_KEY
MINIMAX_API_KEY / MINIMAX_OAUTH_TOKEN
MOONSHOT_API_KEY
KIMI_API_KEY / KIMICODE_API_KEY
SYNTHETIC_API_KEY
VENICE_API_KEY
XIAOMI_API_KEY
QIANFAN_API_KEY
QWEN_PORTAL_API_KEY / QWEN_OAUTH_TOKEN
CHUTES_API_KEY / CHUTES_OAUTH_TOKEN
COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN
CLOUDFLARE_AI_GATEWAY_API_KEY
OLLAMA_API_KEY
AWS_BEARER_TOKEN_BEDROCK / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE
```

### Plugin-Config Credentials
```
TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
TELNYX_API_KEY / TELNYX_CONNECTION_ID
PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN
NGROK_AUTHTOKEN
```

### Skill-Managed Credentials (outside OpenClaw's resolver system)
```
# gog (Google Workspace CLI) — manages own OAuth tokens internally
# Himalaya (IMAP/SMTP) — manages own credentials via config or keyring
GOOGLE_PLACES_API_KEY
NOTION_API_KEY (if used via env)
FIRECRAWL_API_KEY
BRAVE_API_KEY
PERPLEXITY_API_KEY
```
