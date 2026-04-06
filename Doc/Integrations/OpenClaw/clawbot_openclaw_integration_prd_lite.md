# Clawbot / OpenClaw Integration — PRD Lite

## 1) One-line summary
A first-class OpenClaw integration that routes delegated access through agenthifive so provider tokens don’t live in OpenClaw, while keeping the OpenClaw UX workable in local and VPS deployments.

## 2) Problem
OpenClaw commonly uses external CLIs and stores auth profiles/caches locally. On VPS deployments this creates:
- UX friction (localhost callbacks, tunnels, device auth workarounds)
- Security risk (“token on the box” and adjacent to an untrusted runtime)

## 3) Users
- OpenClaw operators (local or VPS Gateway).
- Skill authors relying on gogcli-like commands.
- Security-conscious end users wanting separation between model runtime and secrets.

## 4) Goals (MVP)
1. Make “connect my Google/Microsoft/etc.” remote-friendly (no localhost callback dependency).
2. Keep refresh tokens out of OpenClaw; store only Vault session credentials and connection handles.
3. Default execution to Models B/C; allow Model A only when explicitly enabled.
4. Provide adoption paths for:
   - New builds (Gateway plugin)
   - Legacy skills (CLI compatibility layer)
   - Portability beyond OpenClaw (MCP)

## 5) Non-goals
- Rewriting the entire OpenClaw skill ecosystem immediately; provide migration tools instead.
- Solving all watcher/automation cases day one; stage them explicitly.

## 6) Product packaging (three integration surfaces)

### Surface A (gold path): `@agenthifive/openclaw` Gateway plugin
- Runs in the OpenClaw Gateway (trusted boundary).
- Registers `agenthifive.*` tools and bundles safe usage patterns.
- Stores at most Vault session credentials and `connection_id` references (no provider refresh tokens).

**Required tools (MVP):**
- `connect_start(provider, scopes, label)` → returns `connect_url`, `connect_code`
- `connect_wait(connect_code)` → returns `connection_id`, granted scopes
- `execute(connection_id, operation, limits, constraints)` → routes to typed ops (C) or constrained HTTP (B)
- `approval_request` / `approval_commit` for step-up approvals (“high-five”)
- `connections_list`, `connection_revoke`

### Surface B (migration path): `agentgog` (gogcli compatibility layer)
- Replacement CLI implementing the subset of commands skills rely on, backed by Vault connections/execution.
- Local disk stores only `connection_id` mappings, not provider tokens.
- Watchers (e.g., Gmail Pub/Sub) staged: temporary exceptions vs longer-term Vault-managed automations.

### Surface C (portability path): MCP server + mcporter recipe
- `agenthifive-mcp` exposes connect/execute/revoke tools.
- Allows OpenClaw and other agent clients to consume Vault capabilities portably.

## 7) Core UX flows (MVP)

### Flow A: Remote-friendly connect
1. Agent calls `connect_start` and shows `connect_url`.
2. User opens URL on phone/laptop and approves.
3. Agent calls `connect_wait` and receives `connection_id`.
4. OpenClaw confirms “connected” with scope summary (read-only by default).

### Flow B: Execute (read)
- Agent calls `execute` with a typed op when available; otherwise uses long-tail constrained HTTP via Model B under allowlists, caps, and redaction.

### Flow C: Execute (write) with high-five
- Agent drafts the write action.
- `approval_request` → user approves → `approval_commit` executes and returns `audit_id`.

## 8) MVP requirements checklist
- Plugin config schema: baseUrl, tenantId, namespace mode, auth mode, approval mode.
- Invariant: no provider refresh tokens on the OpenClaw host.
- Logging: propagate `audit_id` into OpenClaw logs for correlation.
- Defaults:
  - Read-only by default.
  - Step-up required for destructive actions.

## 9) Success metrics
- Install → connect completion rate (especially on VPS).
- % legacy workflows migrated via `agentgog`.
- % executions routed through B/C (goal: dominant) vs A (exception).
- Reduction of “token on disk” footprint in OpenClaw deployments (target: zero refresh tokens).

## 10) Risks and open questions
- Watchers/PubSub: accept temporary legacy risk or invest early in Vault-managed automation.
- Ecosystem variance: skills may rely on SDK behaviors awkward through Model B unless adapters exist.
- Credential boundary clarity: consistently message “Gateway/plugin is trusted; model runtime is not”.
