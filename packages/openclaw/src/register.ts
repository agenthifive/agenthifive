/**
 * OpenClaw plugin entry point.
 *
 * This file is referenced by the `openclaw.extensions` field in package.json.
 * OpenClaw's plugin loader calls `register(api)` at startup.
 *
 * We deliberately avoid importing any OpenClaw types at compile time —
 * the `api` parameter is typed loosely so this package has zero dependency
 * on OpenClaw internals. This keeps it publishable as a standalone npm package.
 */

import { Type } from "@sinclair/typebox";
import { resolveStateDir } from "./env-paths.js";
import { VaultClient } from "./client.js";
import {
  execute,
  approvalRequest,
  approvalCommit,
  connectionsList,
  connectionRevoke,
} from "./tools.js";
import { writeReferenceFiles, buildChunkedPrompt, buildApiReferencePrompt } from "./prompt-reference.js";
import { VaultTokenManager } from "./vault-token-manager.js";
import { VaultActionProxy } from "./vault-action-proxy.js";
import {
  initPendingApprovals,
  addPendingApproval,
  loadPendingApprovals,
  savePendingApprovals,
  type PendingApproval,
} from "./pending-approvals.js";
import type { PluginLogger } from "./pending-approvals.js";
import { initApprovedLlmApprovals, clearApprovedLlmApproval, storeApprovedLlmApproval } from "./llm-approval-state.js";
import { parseSessionKey, setCurrentSessionContext, getCurrentSessionContext } from "./session-context.js";
import { initChannelLifecycleEvents } from "./channels/lifecycle-events.js";
import { consumeChannelLifecycleContext } from "./channels/lifecycle-context.js";
import { VaultCredentialProvider } from "./vault-provider.js";
import { setVaultBearerToken, setCredentialProvider, setProxiedProviders } from "./runtime.js";
import { verifyPatches } from "./patch-verify.js";
import type {
  OpenClawPluginConfig,
  ExecuteInput,
  ApprovalRequestInput,
  ApprovalCommitInput,
  VaultDebugLevel,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://app.agenthifive.com";
const PLUGIN_ID = "agenthifive";
const PLUGIN_VERSION = "0.4.6";

function normalizeDebugLevel(raw: unknown): VaultDebugLevel | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "silent" || normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return undefined;
}

function derivePluginConfigFromChannelAccount(
  config: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const root = config ?? {};
  const channels = root.channels as Record<string, unknown> | undefined;
  const agenthifive = channels?.agenthifive as Record<string, unknown> | undefined;
  const accounts = agenthifive?.accounts as Record<string, unknown> | undefined;
  const account = (accounts?.default as Record<string, unknown> | undefined)
    ?? (accounts ? (Object.values(accounts)[0] as Record<string, unknown> | undefined) : undefined);

  if (!account) return null;

  const auth = account.auth as Record<string, unknown> | undefined;
  if (!auth?.mode) return null;

  const providers = account.providers as Record<string, Record<string, unknown>> | undefined;
  const connectedProviders = Object.entries(providers ?? {})
    .filter(([, providerCfg]) => providerCfg?.enabled !== false)
    .map(([provider]) => provider);

  const models = root.models as Record<string, unknown> | undefined;
  const modelProviders = models?.providers as Record<string, Record<string, unknown>> | undefined;
  const proxiedProviders = Object.entries(modelProviders ?? {})
    .filter(([, providerCfg]) => providerCfg?.apiKey === "vault-managed")
    .map(([provider]) => provider);

  return {
    ...(typeof account.baseUrl === "string" ? { baseUrl: account.baseUrl } : {}),
    auth,
    ...(normalizeDebugLevel(account.debug_level ?? account.debugLevel)
      ? { debugLevel: normalizeDebugLevel(account.debug_level ?? account.debugLevel) }
      : {}),
    ...(typeof account.pollTimeoutMs === "number" ? { pollTimeoutMs: account.pollTimeoutMs } : {}),
    ...(typeof account.pollIntervalMs === "number" ? { pollIntervalMs: account.pollIntervalMs } : {}),
    ...(connectedProviders.length > 0 ? { connectedProviders } : {}),
    ...(proxiedProviders.length > 0 ? { proxiedProviders } : {}),
  };
}

// ---------------------------------------------------------------------------
// Module-scoped singletons (lifecycle managed by register/stop)
// ---------------------------------------------------------------------------

let _tokenManager: VaultTokenManager | null = null;
let _actionProxy: VaultActionProxy | null = null;
/** Shared mutable auth object — updated in-place by token manager's onRefresh callback */
let _managedAuth: { mode: "bearer"; token: string } | null = null;

/** Resolves when initAgentAuth completes (success or failure) */
let _authReadyResolve: (() => void) | null = null;
const _authReady: Promise<void> = new Promise((resolve) => {
  _authReadyResolve = resolve;
});

/**
 * Waits for the main plugin's auth initialization, then returns the shared
 * action proxy. The channel plugin uses this to avoid creating a duplicate
 * VaultTokenManager with its own background refresh loop.
 * Times out after 15s to avoid blocking the channel plugin indefinitely.
 */
export async function getSharedActionProxy(): Promise<VaultActionProxy | null> {
  await Promise.race([
    _authReady,
    new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
  ]);
  return _actionProxy;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Build an OpenClawPluginConfig from the raw pluginConfig provided by OpenClaw.
 * Applies defaults and normalizes the auth config.
 */
function buildConfig(raw: Record<string, unknown>): OpenClawPluginConfig {
  const baseUrl = (raw.baseUrl as string) || DEFAULT_BASE_URL;
  const authRaw = (raw.auth ?? {}) as Record<string, unknown>;
  const mode = authRaw.mode as string;

  let auth: OpenClawPluginConfig["auth"];
  if (mode === "bearer") {
    auth = { mode: "bearer", token: authRaw.token as string };
  } else {
    // Default to agent mode
    const privateKeyRaw = authRaw.privateKey as string | undefined;
    let privateKey: JsonWebKey;
    if (privateKeyRaw) {
      try {
        // Accept both raw JSON and base64-encoded JWK
        privateKey = JSON.parse(privateKeyRaw) as JsonWebKey;
      } catch {
        privateKey = JSON.parse(
          Buffer.from(privateKeyRaw, "base64").toString("utf-8"),
        ) as JsonWebKey;
      }
    } else {
      throw new Error(
        "AgentHiFive plugin: auth.privateKey is required for agent mode",
      );
    }
    // Validate key type — only ES256 (EC P-256) is supported
    if (privateKey.kty !== "EC") {
      throw new Error(
        `AgentHiFive plugin: private key must be EC type (got "${privateKey.kty ?? "unknown"}")`,
      );
    }
    if (privateKey.crv && privateKey.crv !== "P-256") {
      throw new Error(
        `AgentHiFive plugin: private key must use P-256 curve for ES256 (got "${privateKey.crv}")`,
      );
    }
    auth = {
      mode: "agent",
      agentId: authRaw.agentId as string,
      privateKey,
      ...(authRaw.tokenAudience ? { tokenAudience: authRaw.tokenAudience as string } : {}),
    };
  }

  return {
    baseUrl,
    auth,
    debugLevel: normalizeDebugLevel(raw.debugLevel ?? raw.debug_level) ?? "error",
    pollTimeoutMs: (raw.pollTimeoutMs as number) ?? 300_000,
    pollIntervalMs: (raw.pollIntervalMs as number) ?? 3_000,
  };
}

// ---------------------------------------------------------------------------
// Tool builders — convert our tool definitions to OpenClaw's AgentTool format
// ---------------------------------------------------------------------------

/**
 * Build all 5 vault tools as OpenClaw AgentTool objects.
 *
 * OpenClaw uses @mariozechner/pi-agent-core's AgentTool interface:
 *   { name, label, description, parameters (TypeBox TSchema), execute }
 *
 * We use the `registerTool` factory form which receives a context object
 * and returns tool(s). This avoids importing pi-agent-core at compile time.
 * Instead we build plain objects that match the expected shape — OpenClaw's
 * loader coerces them via its own adapter.
 */
function buildVaultTools(client: VaultClient, config: OpenClawPluginConfig) {
  return [
    {
      name: "vault_execute",
      label: "Vault Execute",
      description:
        "Execute an HTTP request through the AgentHiFive Vault proxy (Model B). " +
        "The Vault handles authentication and policy enforcement. " +
        "Use 'service' for singleton services (Telegram, Anthropic) or 'connectionId' for multi-account services (Google, Microsoft). " +
        "Do NOT add Authorization headers — the vault handles authentication automatically.",
      parameters: Type.Object({
        connectionId: Type.Optional(Type.String({ description: "The connection ID to use (for multi-account services like Google, Microsoft)" })),
        service: Type.Optional(Type.String({ description: "Service name for singleton services (e.g. 'telegram', 'slack', 'anthropic-messages')" })),
        method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE"), Type.Literal("PATCH")], { description: "HTTP method" }),
        url: Type.String({ description: "Target URL for the provider API" }),
        query: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Query parameters as key-value pairs" })),
        headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional headers (Authorization is injected by Vault)" })),
        body: Type.Optional(Type.Unknown({ description: "Request body (for POST, PUT, PATCH)" })),
        approvalId: Type.Optional(Type.String({ description: "Approval request ID to bypass a require_approval guard" })),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const input: ExecuteInput = {
          method: params.method as ExecuteInput["method"],
          url: params.url as string,
        };
        if (params.connectionId)
          input.connectionId = params.connectionId as string;
        if (params.service) input.service = params.service as string;
        if (params.query)
          input.query = params.query as Record<string, string>;
        if (params.headers)
          input.headers = params.headers as Record<string, string>;
        if (params.body !== undefined) input.body = params.body;
        if (params.approvalId)
          input.approvalId = params.approvalId as string;

        const result = await execute(client, input);

        // Track pending approvals for background watcher wake-up
        if ("approvalRequired" in result && result.approvalRequired) {
          const sessionCtx = getCurrentSessionContext();
          const pending: import("./pending-approvals.js").PendingApproval = {
            approvalRequestId: result.approvalRequestId,
            method: input.method,
            url: input.url,
            summary: `${input.method} ${input.url}`,
            createdAt: new Date().toISOString(),
          };
          if (input.service) pending.service = input.service;
          if (input.connectionId) pending.connectionId = input.connectionId;
          if (sessionCtx?.sessionKey) pending.sessionKey = sessionCtx.sessionKey;
          if (sessionCtx?.channel) pending.channel = sessionCtx.channel;
          if (sessionCtx?.peerId) pending.peerId = sessionCtx.peerId;
          if (sessionCtx?.peerKind) pending.peerKind = sessionCtx.peerKind;
          addPendingApproval(pending);
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "request_permission",
      label: "Request Permission",
      description:
        "Request a capability/permission from the workspace owner via the AgentHiFive vault. " +
        "The user must approve via the AgentHiFive dashboard before the action executes.",
      parameters: Type.Object({
        connectionId: Type.String({ description: "The connection ID for this action" }),
        actionDescription: Type.String({ description: "Human-readable description of the action" }),
        method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE"), Type.Literal("PATCH")], { description: "HTTP method for the action" }),
        url: Type.String({ description: "Target URL for the action" }),
        body: Type.Optional(Type.Unknown({ description: "Request body for the action" })),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const input: ApprovalRequestInput = {
          connectionId: params.connectionId as string,
          actionDescription: params.actionDescription as string,
          method: params.method as ApprovalRequestInput["method"],
          url: params.url as string,
        };
        if (params.body !== undefined) input.body = params.body;

        const result = await approvalRequest(client, input);

        // Track pending approval for the background watcher
        const sessionCtx = getCurrentSessionContext();
        const pending: PendingApproval = {
          approvalRequestId: result.approvalRequestId,
          method: input.method,
          url: input.url,
          summary: input.actionDescription || `${input.method} ${input.url}`,
          createdAt: new Date().toISOString(),
        };
        if (input.connectionId) pending.connectionId = input.connectionId;
        if (sessionCtx?.sessionKey) pending.sessionKey = sessionCtx.sessionKey;
        if (sessionCtx?.channel) pending.channel = sessionCtx.channel;
        if (sessionCtx?.peerId) pending.peerId = sessionCtx.peerId;
        if (sessionCtx?.peerKind) pending.peerKind = sessionCtx.peerKind;
        addPendingApproval(pending);

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "request_capability",
      label: "Request Capability",
      description:
        "Request access to a new service/capability from the workspace owner. " +
        "Use when the user asks about a vault-supported service that has no active connection. " +
        "The workspace owner will see the request in the AgentHiFive dashboard and can connect the service and approve access.",
      parameters: Type.Object({
        actionTemplateId: Type.String({ description: "Action template ID from the vault reference (e.g., 'telegram', 'gmail-manage', 'notion-read')" }),
        reason: Type.String({ description: "Why the agent needs this capability (e.g., 'User wants to send Telegram messages')" }),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        try {
          const result = await client.post<{ id: string; actionTemplateId: string }>("/v1/agent-permission-requests", {
            actionTemplateId: params.actionTemplateId as string,
            reason: params.reason as string,
          });
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                requestId: result.id,
                actionTemplateId: result.actionTemplateId,
                message: "Permission request submitted. The workspace owner will be notified in the AgentHiFive dashboard. They need to approve the request and connect the service.",
              }),
            }],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, error: `Failed to submit capability request: ${message}` }),
            }],
          };
        }
      },
    },
    {
      name: "vault_await_approval",
      label: "Vault Await Approval",
      description:
        "(Fallback only) Block until a step-up approval resolves. Do NOT use by default — the system auto-notifies you when approvals resolve. Only use if the user explicitly asks you to wait inline.",
      parameters: Type.Object({
        approvalRequestId: Type.String({ description: "The approval request ID from vault_execute or request_permission" }),
        timeoutMs: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 300000 = 5 min)" })),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const input: ApprovalCommitInput = {
          approvalRequestId: params.approvalRequestId as string,
        };
        if (typeof params.timeoutMs === "number")
          input.timeoutMs = params.timeoutMs;
        const result = await approvalCommit(
          client,
          input,
          config.pollTimeoutMs,
          config.pollIntervalMs,
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "vault_connections_list",
      label: "List Vault Connections",
      description:
        "List all active connections in the AgentHiFive vault. Shows provider, status, and granted scopes for each connection.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = await connectionsList(client);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
    {
      name: "vault_connection_revoke",
      label: "Vault Connection Revoke",
      description:
        "Immediately revoke a connection. This blocks all future token vending and execution through this connection.",
      parameters: Type.Object({
        connectionId: Type.String({ description: "The connection ID to revoke" }),
      }),
      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
      ) => {
        const result = await connectionRevoke(client, {
          connectionId: params.connectionId as string,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Approval notification — polls pending approvals, injects resolved ones
// ---------------------------------------------------------------------------

async function checkPendingApprovals(
  config: OpenClawPluginConfig,
  logger: PluginLogger,
): Promise<string | null> {
  const pending = loadPendingApprovals();
  if (pending.length === 0) {
    return null;
  }

  if (!_actionProxy) {
    return null;
  }

  const notifications: string[] = [];
  const stillPending = [];

  for (const approval of pending) {
    // Skip expired approvals
    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      notifications.push(
        `- Your request "${approval.summary}" has EXPIRED. Submit a new request without approvalId.`,
      );
      continue;
    }

    try {
      const response = await fetch(`${config.baseUrl}/v1/approvals/${approval.approvalRequestId}`, {
        method: "GET",
        headers: _actionProxy.buildAuthHeader(),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        stillPending.push(approval);
        continue;
      }

      const body = (await response.json()) as { approval?: { status?: string }; status?: string };
      const status = body.approval?.status ?? body.status;

      if (status === "approved") {
        if (approval.sessionKey && approval.url.startsWith("llm://")) {
          storeApprovedLlmApproval(approval.sessionKey, approval.approvalRequestId);
        }
        notifications.push(
          `- Your request "${approval.summary}" was APPROVED. ` +
            `Re-submit the exact same vault_execute call with approvalId: "${approval.approvalRequestId}"`,
        );
      } else if (status === "denied") {
        if (approval.sessionKey && approval.url.startsWith("llm://")) {
          clearApprovedLlmApproval(approval.sessionKey);
        }
        notifications.push(
          `- Your request "${approval.summary}" was DENIED by the workspace owner.`,
        );
      } else if (status === "expired" || status === "consumed") {
        if (approval.sessionKey && approval.url.startsWith("llm://")) {
          clearApprovedLlmApproval(approval.sessionKey);
        }
        notifications.push(
          `- Your request "${approval.summary}" is ${status}. Submit a new request if needed.`,
        );
      } else {
        stillPending.push(approval);
      }
    } catch {
      stillPending.push(approval);
    }
  }

  savePendingApprovals(stillPending);

  if (notifications.length === 0) {
    return null;
  }

  return [
    `<vault-approval-updates>`,
    `The following step-up approval requests have been resolved since your last turn:`,
    ...notifications,
    `</vault-approval-updates>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Background approval watcher — polls AH5 API and wakes agent
// ---------------------------------------------------------------------------

const WATCHER_POLL_MS = 5_000;
const APPROVAL_REQUEST_ID_RE = /\bapprovalRequestId\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

function trackLlmApprovalFromOutput(params: {
  assistantTexts: string[];
  provider: string;
  model: string;
  sessionKey?: string;
  channelId?: string;
}): void {
  const joined = params.assistantTexts.join("\n").trim();
  if (!joined || !joined.includes("approvalRequestId")) {
    return;
  }

  const match = joined.match(APPROVAL_REQUEST_ID_RE);
  const approvalRequestId = match?.[1];
  if (!approvalRequestId) {
    return;
  }

  const fallbackSessionKey = params.sessionKey || getCurrentSessionContext()?.sessionKey;

  addPendingApproval({
    approvalRequestId,
    method: "POST",
    url: `llm://${params.provider}/${params.model}`,
    summary: `LLM request via ${params.provider}/${params.model}`,
    createdAt: new Date().toISOString(),
    ...(fallbackSessionKey ? { sessionKey: fallbackSessionKey } : {}),
    ...(params.channelId ? { channel: params.channelId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Wake agent via OpenClaw plugin runtime API
// ---------------------------------------------------------------------------

/**
 * Runtime functions captured from api.runtime.system in register().
 * These are the same functions that /hooks/wake calls internally,
 * but callable directly — no HTTP, no hooks.token needed.
 */
let _enqueueSystemEvent: ((text: string, options: { sessionKey: string }) => boolean) | null = null;
let _requestHeartbeatNow: ((opts?: { reason?: string }) => void) | null = null;
let _mainSessionKey: string | null = null;

/**
 * Wake the agent by injecting text into the session's system event queue
 * and triggering an immediate heartbeat.
 *
 * Uses the OpenClaw plugin runtime API directly (enqueueSystemEvent +
 * requestHeartbeatNow) — same mechanism as /hooks/wake but without HTTP.
 */
async function wakeAgent(
  message: string,
  logger: PluginLogger,
): Promise<boolean> {
  if (_enqueueSystemEvent && _mainSessionKey) {
    try {
      const enqueued = _enqueueSystemEvent(message, { sessionKey: _mainSessionKey });
      if (enqueued && _requestHeartbeatNow) {
        _requestHeartbeatNow({ reason: "ah5:wake" });
      }
      return enqueued;
    } catch (err) {
      logger.error?.(`[AH5] enqueueSystemEvent failed: ${String(err)}`);
    }
  }
  // Runtime not available — messages are still in the in-memory buffer
  // for before_agent_start hook pickup on next user-initiated turn.
  return false;
}

export function shouldAutoWakeForResolvedApproval(approval: Pick<PendingApproval, "url">): boolean {
  // LLM step-up approvals should be replayed on the next real user turn.
  // Auto-waking the agent here can silently consume the approval before the
  // user types anything back in the TUI/webchat session.
  return !approval.url.startsWith("llm://");
}

/** Background approval watcher interval */
let _approvalWatcherInterval: ReturnType<typeof setInterval> | null = null;

function startApprovalWatcher(logger: PluginLogger): void {
  if (_approvalWatcherInterval) return;

  // Watcher started silently — only log errors and approval outcomes

  _approvalWatcherInterval = setInterval(async () => {
    try {
      const pending = loadPendingApprovals();
      if (pending.length === 0) return;
      if (!_actionProxy) return;

      const stillPending: PendingApproval[] = [];
      const resolved: Array<{ approval: PendingApproval; text: string }> = [];

      for (const approval of pending) {
        // Skip expired
        if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
          resolved.push({
            approval,
            text: `Your request "${approval.summary}" has EXPIRED. Submit a new request without approvalId.`,
          });
          continue;
        }

        try {
          const response = await fetch(
            `${_actionProxy.baseUrl}/v1/approvals/${approval.approvalRequestId}`,
            {
              headers: _actionProxy.buildAuthHeader(),
              signal: AbortSignal.timeout(8_000),
            },
          );
          if (!response.ok) {
            stillPending.push(approval);
            continue;
          }
          const data = (await response.json()) as { approval?: { status?: string }; status?: string };
          const status = data.approval?.status ?? data.status;

          if (status === "approved") {
            if (approval.sessionKey && approval.url.startsWith("llm://")) {
              storeApprovedLlmApproval(approval.sessionKey, approval.approvalRequestId);
            }
            resolved.push({
              approval,
              text: `Request "${approval.summary}" APPROVED — re-submit with approvalId "${approval.approvalRequestId}".`,
            });
          } else if (status === "denied") {
            if (approval.sessionKey && approval.url.startsWith("llm://")) {
              clearApprovedLlmApproval(approval.sessionKey);
            }
            resolved.push({
              approval,
              text: `Your request "${approval.summary}" was DENIED by the workspace owner.`,
            });
          } else if (status === "expired" || status === "consumed") {
            if (approval.sessionKey && approval.url.startsWith("llm://")) {
              clearApprovedLlmApproval(approval.sessionKey);
            }
            resolved.push({
              approval,
              text: `Your request "${approval.summary}" is ${status}. Submit a new request if needed.`,
            });
          } else {
            stillPending.push(approval);
          }
        } catch {
          stillPending.push(approval);
        }
      }

      savePendingApprovals(stillPending);

      if (resolved.length === 0) return;

      // Wake the agent — injects into session event queue + triggers heartbeat
      for (const { approval, text } of resolved) {
        if (!shouldAutoWakeForResolvedApproval(approval)) {
          continue;
        }
        await wakeAgent(`[AH5 Vault] ${text}`, logger);
      }
    } catch (err) {
      logger.error?.(`approval watcher error: ${String(err)}`);
    }
  }, WATCHER_POLL_MS);

  // Don't keep the process alive just for approval polling (CLI commands like
  // `openclaw plugins list` would hang indefinitely without this).
  if (
    _approvalWatcherInterval &&
    typeof _approvalWatcherInterval === "object" &&
    "unref" in _approvalWatcherInterval
  ) {
    _approvalWatcherInterval.unref();
  }
}

function stopApprovalWatcher(): void {
  if (_approvalWatcherInterval) {
    clearInterval(_approvalWatcherInterval);
    _approvalWatcherInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Agent auth initialization (ES256 token management)
// ---------------------------------------------------------------------------

async function initAgentAuth(
  config: OpenClawPluginConfig,
  pluginConfig: Record<string, unknown>,
  logger: PluginLogger,
): Promise<void> {
  if (config.auth.mode !== "agent") {
    // Bearer mode — set up directly without token manager
    _managedAuth = { mode: "bearer", token: config.auth.token };
    _actionProxy = new VaultActionProxy({
      baseUrl: config.baseUrl,
      auth: _managedAuth,
      timeoutMs: 65_000,
    });
    // Set runtime state for patch consumers
    setVaultBearerToken(config.auth.token);
    initRuntimeProvider(config, pluginConfig, logger);
    return;
  }

  // Agent mode — ES256 JWT-based auth with background token refresh
  _managedAuth = { mode: "bearer", token: "" };

  _tokenManager = new VaultTokenManager({
    baseUrl: config.baseUrl,
    agentId: config.auth.agentId,
    privateKey: config.auth.privateKey,
    logger,
    ...(config.debugLevel ? { debugLevel: config.debugLevel } : {}),
    ...(config.auth.tokenAudience ? { tokenAudience: config.auth.tokenAudience } : {}),
  });

  _tokenManager.onRefresh = (newToken: string) => {
    if (_managedAuth) {
      _managedAuth.token = newToken;
    }
  };

  _tokenManager.onAuthFailure = () => {
    logger.error?.(
      "AgentHiFive: agent key pair rejected (401). Generate a new bootstrap secret " +
        "from the AgentHiFive dashboard, then reconfigure.",
    );
  };

  // Initial token exchange with retries
  const retryDelays = [5_000, 10_000, 30_000, 60_000];
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    try {
      await _tokenManager.init();
      // Auth initialized — silent success

      _actionProxy = new VaultActionProxy({
        baseUrl: config.baseUrl,
        auth: _managedAuth,
        timeoutMs: 65_000,
        onTokenRefresh: () => _tokenManager?.forceRefresh() ?? Promise.resolve(false),
      });

      // Set runtime state for patch consumers
      setVaultBearerToken(_managedAuth.token);
      // Keep runtime token in sync with background refresh
      const prevOnRefresh = _tokenManager.onRefresh;
      _tokenManager.onRefresh = (newToken: string) => {
        prevOnRefresh?.(newToken);
        setVaultBearerToken(newToken);
      };
      initRuntimeProvider(config, pluginConfig, logger);
      return;
    } catch (err) {
      lastError = err;
      if (attempt < retryDelays.length) {
        const delay = retryDelays[attempt]!;
        logger.error?.(
          `AgentHiFive: token exchange failed (attempt ${attempt + 1}/${retryDelays.length + 1}), ` +
            `retrying in ${delay / 1000}s: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, delay);
          if (typeof t === "object" && "unref" in t) (t as NodeJS.Timeout).unref();
        });
      }
    }
  }

  logger.error?.(
    `AgentHiFive: agent auth failed after ${retryDelays.length + 1} attempts. ` +
      `Tools will still work via VaultClient but action proxy is unavailable. ` +
      `Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

// ---------------------------------------------------------------------------
// Runtime provider initialization (for patch consumers)
// ---------------------------------------------------------------------------

function initRuntimeProvider(
  config: OpenClawPluginConfig,
  pluginConfig: Record<string, unknown>,
  logger: PluginLogger,
): void {
  // Set proxied providers list
  const proxied = (pluginConfig.proxiedProviders ?? []) as string[];
  setProxiedProviders(proxied);

  // Set credential provider (currently a stub that returns null —
  // all access goes through Model B. When credential vending is
  // implemented, this will resolve real API keys from the vault.)
  if (!_managedAuth) return;
  const provider = new VaultCredentialProvider({
    baseUrl: config.baseUrl,
    auth: _managedAuth,
    timeoutMs: 30_000,
    cacheTtlMs: 300_000,
    onTokenRefresh: () => _tokenManager?.forceRefresh() ?? Promise.resolve(false),
  });
  setCredentialProvider(provider);

  // proxied providers configured silently
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerAgentHiFivePlugin(api: any): void {
  const pluginConfig =
    ((api.pluginConfig as Record<string, unknown> | undefined)?.auth
      ? (api.pluginConfig as Record<string, unknown>)
      : derivePluginConfigFromChannelAccount(api.config as Record<string, unknown> | undefined)
        ?? (api.pluginConfig ?? {})) as Record<string, unknown>;
  const logger = api.logger ?? console;

  // ── Check if auth is configured ──────────────────────────────────────
  const authRaw = pluginConfig.auth as Record<string, unknown> | undefined;
  if (!authRaw?.mode) {
    logger.info?.(
      `AgentHiFive plugin v${PLUGIN_VERSION} installed but not configured. ` +
        `Run "npx @agenthifive/openclaw-setup" to configure.`,
    );
    return;
  }

  const config = buildConfig(pluginConfig);
  const client = new VaultClient(config);

  // ── Capture runtime system functions (for wakeAgent) ──────────────────
  // These are the same functions /hooks/wake calls internally, but callable
  // directly from the plugin — no HTTP, no hooks.token needed.
  const runtime = api.runtime as {
    system?: {
      enqueueSystemEvent?: (text: string, opts: { sessionKey: string }) => boolean;
      requestHeartbeatNow?: (opts?: { reason?: string }) => void;
    };
  } | undefined;
  if (runtime?.system?.enqueueSystemEvent) {
    _enqueueSystemEvent = runtime.system.enqueueSystemEvent;
    _requestHeartbeatNow = runtime.system.requestHeartbeatNow ?? null;
  }

  // Build main session key from config (same logic as OpenClaw's
  // resolveMainSessionKeyFromConfig in config/sessions/main-session.ts).
  // Refreshed from ctx.sessionKey in before_agent_start once user interacts.
  const ocConfig = api.config as Record<string, unknown> | undefined;
  const agentsList = (ocConfig?.agents as { list?: Array<{ id?: string; default?: boolean }> })?.list ?? [];
  const defaultAgentId = agentsList.find((a) => a.default)?.id ?? agentsList[0]?.id ?? "main";
  const agentId = (defaultAgentId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64)) || "main";
  const sessionMainKey = ((ocConfig?.session as Record<string, unknown>)?.mainKey as string | undefined)
    ?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "main";
  _mainSessionKey = `agent:${agentId}:${sessionMainKey}`;

  // Initialization — only log errors from here on

  // ── Initialize agent auth (token manager + action proxy) ─────────────
  // Fire-and-forget — tools work via VaultClient regardless; action proxy
  // is needed for approval polling and channel watchers.
  const authReady = initAgentAuth(config, pluginConfig, logger).catch((err) => {
    logger.error?.(`AgentHiFive: auth init failed: ${err instanceof Error ? err.message : String(err)}`);
  }).finally(() => {
    _authReadyResolve?.();
  });

  // ── Verify patches (non-blocking) ──────────────────────────────────────
  verifyPatches(logger).catch(() => {
    // Verification failure is non-fatal
  });

  // ── Initialize pending approvals state ───────────────────────────────
  // OpenClaw's plugin API does NOT provide stateDir to external plugins.
  // Derive it: env override → api.stateDir/dataDir fallback → ~/.openclaw
  const stateDir = resolveStateDir((api.stateDir ?? api.dataDir) as string | undefined);
  // stateDir and runtime info available in debug — not shown in TUI
  initPendingApprovals(stateDir, logger);
  initApprovedLlmApprovals(stateDir);

  // Start background approval watcher — polls AH5 API and wakes agent
  // via enqueueSystemEvent when approvals resolve.
  startApprovalWatcher(logger);

  initChannelLifecycleEvents(stateDir, logger);

  // ── Register tools ──────────────────────────────────────────────────────
  const tools = buildVaultTools(client, config);
  for (const tool of tools) {
    api.registerTool(tool);
  }

  // ── Register prompt injection hook ──────────────────────────────────────
  const connectedProviders = (pluginConfig.connectedProviders ?? []) as string[];

  if (stateDir) {
    // Chunked mode — write reference files and inject lean pointer
    try {
      const { basePath, serviceFiles } = writeReferenceFiles(stateDir, logger);
      const prompt = buildChunkedPrompt(basePath, serviceFiles);

      api.on(
        "before_agent_start",
        (_event: unknown, ctx?: { sessionKey?: string }) => {
          // Track session context for approval routing + refresh session key
          if (ctx?.sessionKey) {
            _mainSessionKey = ctx.sessionKey;
            const parsed = parseSessionKey(ctx.sessionKey);
            const sessionCtx: import("./session-context.js").SessionContext = {
              sessionKey: ctx.sessionKey,
            };
            if (parsed.channel) sessionCtx.channel = parsed.channel;
            if (parsed.peerId) sessionCtx.peerId = parsed.peerId;
            if (parsed.peerKind) sessionCtx.peerKind = parsed.peerKind;
            setCurrentSessionContext(sessionCtx);
          }
          return { appendSystemContext: prompt };
        },
        { priority: 10 },
      );

      // Chunked prompt injection enabled silently
    } catch (err) {
      logger.warn?.(`Chunked reference write failed, falling back to inline mode: ${err instanceof Error ? err.stack : String(err)}`);
      // Fall back to inline mode via before_agent_start (NOT before_prompt_build
      // — before_prompt_build is not reliably dispatched for external plugins)
      if (connectedProviders.length > 0) {
        const inlinePrompt = buildApiReferencePrompt(connectedProviders);
        if (inlinePrompt) {
          api.on(
            "before_agent_start",
            () => ({ appendSystemContext: inlinePrompt }),
            { priority: 10 },
          );
          // Inline prompt fallback enabled silently
        }
      }
    }
  } else if (connectedProviders.length > 0) {
    // No state dir — use inline mode via before_agent_start
    const inlinePrompt = buildApiReferencePrompt(connectedProviders);
    if (inlinePrompt) {
      api.on(
        "before_agent_start",
        () => ({ appendSystemContext: inlinePrompt }),
        { priority: 10 },
      );
      // Inline prompt injection enabled silently
    }
  }

  // ── Register approval notification hook ─────────────────────────────────
  api.on(
    "before_agent_start",
    async () => {
      try {
        const notification = await checkPendingApprovals(config, logger);
        return notification ? { appendSystemContext: notification } : undefined;
      } catch (err) {
        logger.error?.(`Approval notification check failed: ${err instanceof Error ? err.stack : String(err)}`);
        return undefined;
      }
    },
    { priority: 5 },
  );

  // ── Track model-output approval guards for auto-wake ────────────────────
  api.on(
    "llm_output",
    (
      event: {
        provider?: string;
        model?: string;
        assistantTexts?: string[];
      },
      ctx?: {
        sessionKey?: string;
        channelId?: string;
      },
    ) => {
      trackLlmApprovalFromOutput({
        assistantTexts: event.assistantTexts ?? [],
        provider: event.provider ?? "unknown-provider",
        model: event.model ?? "unknown-model",
        ...(ctx?.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        ...(ctx?.channelId ? { channelId: ctx.channelId } : {}),
      });
    },
    { priority: 5 },
  );

  // ── Register channel lifecycle follow-up hook ──────────────────────────
  api.on(
    "before_agent_start",
    (_event: unknown, ctx?: { sessionKey?: string }) => {
      try {
        const lifecycleContext = consumeChannelLifecycleContext(ctx?.sessionKey);
        return lifecycleContext ? { appendSystemContext: lifecycleContext } : undefined;
      } catch (err) {
        logger.error?.(`Channel lifecycle follow-up failed: ${err instanceof Error ? err.stack : String(err)}`);
        return undefined;
      }
    },
    { priority: 4 },
  );

  // ── Register shutdown handler ──────────────────────────────────────────
  api.on("gateway_stop", () => {
    stopApprovalWatcher();
  });

  logger.info?.(`AgentHiFive v${PLUGIN_VERSION} ready`);
}

// ---------------------------------------------------------------------------
// Default export — OpenClaw plugin definition
// ---------------------------------------------------------------------------

export default {
  id: PLUGIN_ID,
  name: "AgentHiFive Vault",
  version: PLUGIN_VERSION,
  description:
    "Vault-managed credentials, brokered API proxy, and policy-governed access for AI agents",
  register: registerAgentHiFivePlugin,
};
