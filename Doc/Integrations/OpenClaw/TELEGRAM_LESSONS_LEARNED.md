# Telegram Brokered Proxy (Model B) — Lessons Learned

> **Note (April 2026)**: This document was written during the fork-based approach. The implementation has since moved to a plugin architecture (see [OPENCLAW_TECHNICAL_INTEGRATION.md](./OPENCLAW_TECHNICAL_INTEGRATION.md)). The lessons learned and architectural insights still apply — the Telegram integration uses the same vault proxy pattern, now via `VaultActionProxy` in the `@agenthifive/agenthifive` plugin instead of a fork-side `telegram-proxy.ts`.

First channel integration through the AgentHiFive vault. Took several sessions to get working end-to-end. This doc captures what went wrong, what we learned, and what to watch for on the next channel (MS Teams, Slack).

## What We Built

OpenClaw's Telegram bot → AH5 vault proxy → Telegram Bot API.

- **OpenClaw side:** Custom `fetch` function injected via grammY's `ApiClientOptions.fetch`. Strips bot token from URL, routes all API calls through `POST /v1/vault/execute`.
- **AH5 side:** Vault route detects Telegram provider, re-injects bot token into the URL path (not Authorization header), forwards to `api.telegram.org`, returns parsed JSON response.

## Issues Hit (in order)

### 1. Telegram uses token-in-URL, not Authorization header

**Problem:** All other OAuth providers use `Authorization: Bearer <token>`. Telegram embeds the token in the URL path: `/bot<TOKEN>/sendMessage`. The vault's generic Model B flow was adding an `Authorization` header which Telegram ignores.

**Fix:** Provider-specific branch in vault route — when `connection.provider === "telegram"`, inject token into URL path instead of header. Skip the `Authorization` header entirely.

**Lesson for next channel:** Check how each provider expects credentials. MS Teams uses `Authorization: Bearer` (standard). Slack uses `Authorization: Bearer` for Web API but has a different flow for Events API. Don't assume all providers work the same.

### 2. Timeout race: 30s proxy timeout vs 25s Telegram long-poll

**Problem:** grammY's `getUpdates` uses long polling (default 25s timeout). The vault proxy had a 30s timeout. Under network jitter, the proxy would sometimes kill the connection before Telegram responded, causing retries that snowballed.

**Fix:** Increased vault timeout to 60s (well above Telegram's 25s long-poll). The real timeout is Telegram's — the proxy just needs to be generous.

**Lesson for next channel:** Understand the provider's timeout semantics before setting proxy timeouts. Long-polling channels need extra headroom. Request-response channels (MS Teams Graph API) can use tighter timeouts.

### 3. Response header contamination (content-encoding, transfer-encoding)

**Problem:** The vault forwarded all response headers from Telegram, including `content-encoding: gzip` and `transfer-encoding: chunked`. But the vault already decompressed and re-serialized the body. grammY received a `content-encoding: gzip` header with a plaintext JSON body and choked.

**Fix:** OpenClaw's `telegram-proxy.ts` strips transport-level headers (`content-encoding`, `content-length`, `transfer-encoding`, `connection`) from the vault response before constructing the `Response` object.

**Lesson for next channel:** This will happen for *every* channel. Consider adding header stripping to the vault route itself rather than requiring each client to handle it. At minimum, strip `content-encoding` and `transfer-encoding` from Model B responses server-side.

### 4. Orphan `getUpdates` causing Telegram 409 conflicts

**Problem:** When OpenClaw restarted or the grammY runner stopped, the previous `getUpdates` long-poll was still in flight at the vault. Telegram only allows one active `getUpdates` per bot token — the second request gets `409 Conflict`, causing an error loop.

**Fix:** Two-part:
1. `VaultActionProxy.execute()` accepts an optional `AbortSignal` parameter
2. `telegram-proxy.ts` forwards grammY's runner abort signal through to the vault HTTP request
3. `AbortSignal.any([timeoutSignal, callerSignal])` ensures both timeout and caller abort tear down the connection

**Lesson for next channel:** Any channel that uses long-lived connections or polling needs abort signal propagation. Slack's Socket Mode (WebSocket) and MS Teams' webhook subscriptions have similar lifecycle concerns. Always wire up the caller's abort/shutdown signal.

### 5. DM pairing blocking messages

**Problem:** OpenClaw's default `dmPolicy: "pairing"` requires unknown Telegram users to go through a CLI-based pairing flow. With vault active, this makes no sense — the AH5 dashboard should manage access, not the CLI.

**Fix:** Runtime override in `bot.ts`: when `connectionId` exists (vault is active), force `dmPolicy: "open"` and `allowFrom: ["*"]`. Access control moves to AH5's `providerConstraints.allowedChatIds`.

**Lesson for next channel:** Each channel has its own access control model. When integrating with AH5, identify the channel's native access control and decide where the authority boundary sits. For Telegram it was `dmPolicy`/`allowFrom`. For Slack it will be workspace membership. For MS Teams it will be tenant/team membership.

### 6. Empty `allowedChatIds` denying all requests

**Problem:** The vault policy engine treated empty `allowedChatIds` as "deny everyone" instead of "no restriction".

**Fix:** Changed the logic: empty array = allow all, populated array = only those IDs.

**Lesson for next channel:** Decide the empty-means-what semantics for each constraint type upfront. Document it. "Empty = no restriction" is the right default for most constraints.

### 7. `fast-json-stringify` silently dropping fields

**Problem:** The vault response included `body`, `headers`, and `auditId` fields, but the Fastify response schema was too narrow. `fast-json-stringify` silently dropped fields not in the schema, causing the OpenClaw client to receive empty responses.

**Fix:** Ensured the Swagger/OpenAPI response schema in the vault route includes all fields that the response actually contains.

**Lesson for next channel:** Always check the Fastify route's response schema when adding new fields to a response. If a field isn't in the schema, it vanishes silently. This is a Fastify-specific gotcha.

## Architecture Patterns That Worked

1. **Custom `fetch` injection** — grammY, `@slack/web-api`, and `@microsoft/microsoft-graph-client` all accept custom fetch/transport. This is the right abstraction point for proxy injection.

2. **AbortSignal propagation** — threading the caller's abort signal all the way through the proxy chain ensures clean shutdown. Use `AbortSignal.any()` to combine timeout + caller signals.

3. **Token-in-URL stripping** — the client strips secrets from the request, the vault re-injects them server-side. The token never leaves the vault.

4. **Layered access control** — OpenClaw handles "can this user talk to the bot?" (channel-level). AH5 handles "should this request go through?" (policy-level). Neither needs to know about the other's details.

## What to Do Differently Next Time

1. **Start with the provider's auth mechanism.** Don't assume Bearer tokens. Check the docs.
2. **Strip transport headers server-side.** Add `content-encoding`, `transfer-encoding`, `content-length` stripping to the vault's Model B response path, not client-side.
3. **Set proxy timeout > provider timeout** from the start. Don't match or slightly exceed — give 2x headroom.
4. **Add debug logging as structured log levels** (`debug` not `info`), gated behind a log level config, not hardcoded `fastify.log.info` that needs manual cleanup.
5. **Wire up abort signals from day 1.** Don't treat it as a follow-up fix.
6. **Test the full cycle early:** receive message → agent processes → send response → delivered. Don't test each direction in isolation.

## Files Involved (Reference)

### AH5 (AgentHiFive)
| File | Role |
|------|------|
| `apps/api/src/routes/vault.ts` | Vault execute route — token injection, policy eval, provider proxying |
| `apps/api/src/utils/telegram-message.ts` | Telegram URL/payload parsing helpers |
| `apps/web/.../policies/page.tsx` | Policy UI — Telegram Users section + creation wizard |
| `packages/contracts/src/policy.ts` | `ProviderConstraintsSchema` (allowedChatIds) |

### OpenClaw Fork
| File | Role |
|------|------|
| `src/telegram/telegram-proxy.ts` | Proxied fetch factory for grammY |
| `src/telegram/bot.ts` | Bot setup — vault-aware dmPolicy override |
| `src/credentials/vault-action-proxy.ts` | Generic vault proxy client (AbortSignal support) |
| `src/credentials/action-proxy.ts` | ActionProxy interface |
| `src/commands/onboard-vault-integrations.ts` | Onboarding wizard — vault auto-config |
