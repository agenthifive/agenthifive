import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { createTelegramChannelRuntime } from "./channel.js";
import { createSlackChannelRuntime } from "./slack-runtime.js";
import { startChannelApprovalWatcher } from "./approval-watcher.js";
import { initPendingChannelActions } from "./pending-actions.js";
import { initChannelLifecycleEvents } from "./lifecycle-events.js";
import { VaultActionProxy } from "../vault-action-proxy.js";
import { VaultTokenManager } from "../vault-token-manager.js";
import type { OpenClawPluginConfig, VaultDebugLevel } from "../types.js";
import { getSharedActionProxy } from "../register.js";
import { adaptChannelActionResponse } from "./outbound.js";
import { resolveStateDir } from "../env-paths.js";
import { startSlackInboundGateway, startTelegramInboundGateway } from "./inbound.js";

const CHANNEL_ID = "agenthifive";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_BASE_URL = "https://app.agenthifive.com";

type OpenClawSdkCoreModule = typeof import("openclaw/plugin-sdk/core");

type RawAccountConfig = {
  name?: string;
  enabled?: boolean;
  baseUrl?: string;
  auth?: {
    mode?: "bearer" | "agent";
    token?: string;
    agentId?: string;
    privateKey?: JsonWebKey | string;
    tokenAudience?: string;
  };
  providers?: {
    telegram?: {
      enabled?: boolean;
      dmPolicy?: string;
      allowFrom?: Array<string | number>;
    };
    slack?: {
      enabled?: boolean;
    };
  };
  debug_level?: VaultDebugLevel;
  debugLevel?: VaultDebugLevel;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export type Ah5ChannelAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  baseUrl: string;
  auth: OpenClawPluginConfig["auth"] | null;
  telegramEnabled: boolean;
  slackEnabled: boolean;
  dmPolicy: string;
  allowFrom: string[];
  debugLevel: VaultDebugLevel;
  pollIntervalMs: number;
  pollTimeoutMs: number;
};

type GatewayResource = {
  stop(): void;
};

const accountResources = new Map<string, GatewayResource>();
let runtimeRef: PluginRuntime | null = null;

function wakeChannelSession(sessionKey: string | undefined, message: string): void {
  if (!sessionKey || !runtimeRef?.system?.enqueueSystemEvent) {
    return;
  }

  try {
    const enqueued = runtimeRef.system.enqueueSystemEvent(message, { sessionKey });
    if (enqueued) {
      runtimeRef.system.requestHeartbeatNow?.({ reason: "ah5:channel-lifecycle" });
    }
  } catch {
    // Best effort only; lifecycle events remain persisted for next turn pickup.
  }
}

function summarizeLifecycleWake(event: {
  type: string;
  provider: string;
  action: string;
  approvalRequestId: string;
  status?: string;
}): string {
  if (event.type === "channel_action_pending_approval") {
    return `[AgentHiFive] ${event.provider} ${event.action} requires approval (${event.approvalRequestId}).`;
  }
  return `[AgentHiFive] ${event.provider} ${event.action} resolved with status ${event.status ?? "unknown"} (${event.approvalRequestId}).`;
}

function normalizeAccountId(accountId?: string | null): string {
  const trimmed = accountId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ACCOUNT_ID;
}

function normalizePrivateKey(raw: JsonWebKey | string | undefined): JsonWebKey | null {
  if (!raw) return null;
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw) as JsonWebKey;
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as JsonWebKey;
    } catch {
      return null;
    }
  }
}

function normalizeDebugLevel(raw: unknown): VaultDebugLevel {
  if (typeof raw !== "string") return "error";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "silent" || normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return "error";
}

function getChannelSection(cfg: OpenClawConfig): {
  accounts?: Record<string, RawAccountConfig>;
  baseUrl?: string;
  auth?: RawAccountConfig["auth"];
  enabled?: boolean;
  providers?: RawAccountConfig["providers"];
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
} {
  const root = cfg as Record<string, unknown>;
  const channels = root.channels as Record<string, unknown> | undefined;
  return (channels?.[CHANNEL_ID] as ReturnType<typeof getChannelSection> | undefined) ?? {};
}

function getRawAccount(cfg: OpenClawConfig, accountId?: string | null): RawAccountConfig {
  const normalizedId = normalizeAccountId(accountId);
  const section = getChannelSection(cfg);
  const explicit = section.accounts?.[normalizedId];
  if (explicit) return explicit;

  const fallback: RawAccountConfig = {};
  if (section.enabled !== undefined) fallback.enabled = section.enabled;
  if (section.baseUrl !== undefined) fallback.baseUrl = section.baseUrl;
  if (section.auth !== undefined) fallback.auth = section.auth;
  if (section.providers !== undefined) fallback.providers = section.providers;
  if ((section as Record<string, unknown>).debug_level !== undefined) fallback.debug_level = (section as Record<string, unknown>).debug_level as VaultDebugLevel;
  if ((section as Record<string, unknown>).debugLevel !== undefined) fallback.debugLevel = (section as Record<string, unknown>).debugLevel as VaultDebugLevel;
  if (section.pollIntervalMs !== undefined) fallback.pollIntervalMs = section.pollIntervalMs;
  if (section.pollTimeoutMs !== undefined) fallback.pollTimeoutMs = section.pollTimeoutMs;
  return fallback;
}

function normalizeAuth(raw: RawAccountConfig["auth"]): OpenClawPluginConfig["auth"] | null {
  if (!raw?.mode) return null;
  if (raw.mode === "bearer") {
    return raw.token ? { mode: "bearer", token: raw.token } : null;
  }

  const privateKey = normalizePrivateKey(raw.privateKey);
  if (!raw.agentId || !privateKey) return null;
  return {
    mode: "agent",
    agentId: raw.agentId,
    privateKey,
    ...(raw.tokenAudience ? { tokenAudience: raw.tokenAudience } : {}),
  };
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): Ah5ChannelAccount {
  const normalizedId = normalizeAccountId(accountId);
  const raw = getRawAccount(cfg, normalizedId);
  const telegram = raw.providers?.telegram;
  const slack = raw.providers?.slack;

  return {
    accountId: normalizedId,
    enabled: raw.enabled !== false,
    baseUrl: (raw.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
    auth: normalizeAuth(raw.auth),
    telegramEnabled: telegram?.enabled !== false,
    slackEnabled: slack?.enabled !== false,
    dmPolicy: telegram?.dmPolicy?.trim() || "balanced",
    allowFrom: (telegram?.allowFrom ?? []).map((entry) => String(entry)).filter(Boolean),
    debugLevel: normalizeDebugLevel(raw.debug_level ?? raw.debugLevel),
    pollIntervalMs: raw.pollIntervalMs ?? 3_000,
    pollTimeoutMs: raw.pollTimeoutMs ?? 300_000,
    ...(raw.name ? { name: raw.name } : {}),
  };
}

function isConfiguredAccount(account: Ah5ChannelAccount): boolean {
  if (!account.baseUrl) return false;
  if (!account.auth) return false;
  if (account.auth.mode === "bearer") return Boolean(account.auth.token);
  return Boolean(account.auth.agentId && account.auth.privateKey);
}

function ensureChannelSection(cfg: OpenClawConfig): Record<string, unknown> {
  const root = (cfg ?? {}) as Record<string, unknown>;
  const channels = (root.channels as Record<string, unknown> | undefined) ?? {};
  root.channels = channels;
  const section = (channels[CHANNEL_ID] as Record<string, unknown> | undefined) ?? {};
  channels[CHANNEL_ID] = section;
  return section;
}

function applySetupConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: {
    name?: string;
    token?: string;
    url?: string;
    userId?: string;
    privateKey?: string;
    audience?: string;
  };
}): OpenClawConfig {
  const root = structuredClone((params.cfg ?? {}) as Record<string, unknown>) as OpenClawConfig;
  const section = ensureChannelSection(root);
  const accounts = (section.accounts as Record<string, RawAccountConfig> | undefined) ?? {};
  section.accounts = accounts;

  const next: RawAccountConfig = { ...(accounts[params.accountId] ?? {}) };
  if (params.input.name?.trim()) next.name = params.input.name.trim();
  if (params.input.url?.trim()) next.baseUrl = params.input.url.trim();
  next.enabled = true;

  if (params.input.token?.trim()) {
    next.auth = { mode: "bearer", token: params.input.token.trim() };
  } else if (params.input.userId?.trim() && params.input.privateKey?.trim()) {
    next.auth = {
      mode: "agent",
      agentId: params.input.userId.trim(),
      privateKey: params.input.privateKey.trim(),
      ...(params.input.audience?.trim() ? { tokenAudience: params.input.audience.trim() } : {}),
    };
  }

  if (!next.providers) {
    next.providers = { telegram: { enabled: true }, slack: { enabled: true } };
  }
  next.providers.telegram = {
    enabled: next.providers.telegram?.enabled !== false,
    dmPolicy: next.providers.telegram?.dmPolicy ?? "balanced",
    allowFrom: next.providers.telegram?.allowFrom ?? [],
  };
  next.providers.slack = {
    enabled: next.providers.slack?.enabled !== false,
  };

  accounts[params.accountId] = next;
  return root;
}

async function createApprovalProxy(account: Ah5ChannelAccount): Promise<{
  proxy: VaultActionProxy;
  stop(): void;
}> {
  if (!account.auth) {
    throw new Error(`AgentHiFive account "${account.accountId}" is not configured`);
  }

  // Reuse the shared action proxy from the main plugin when available.
  // This avoids creating a duplicate VaultTokenManager with its own
  // background refresh loop and duplicate 401 error messages.
  const shared = await getSharedActionProxy();
  if (shared) {
    return { proxy: shared, stop() {} };
  }

  if (account.auth.mode === "bearer") {
    return {
      proxy: new VaultActionProxy({
        baseUrl: account.baseUrl,
        auth: { mode: "bearer", token: account.auth.token },
        timeoutMs: account.pollTimeoutMs,
      }),
      stop() {},
    };
  }

  // Fallback: create own token manager if the main plugin hasn't initialized yet
  const manager = new VaultTokenManager({
    baseUrl: account.baseUrl,
    agentId: account.auth.agentId,
    privateKey: account.auth.privateKey,
    debugLevel: account.debugLevel,
    ...(account.auth.tokenAudience ? { tokenAudience: account.auth.tokenAudience } : {}),
  });
  await manager.init();

  const auth = { mode: "bearer" as const, token: manager.getToken() };
  manager.onRefresh = (token) => {
    auth.token = token;
  };

  return {
    proxy: new VaultActionProxy({
      baseUrl: account.baseUrl,
      auth,
      timeoutMs: account.pollTimeoutMs,
      onTokenRefresh: () => manager.forceRefresh(),
    }),
    stop() {
      manager.stop();
    },
  };
}

function buildSyntheticDeliveryResult(params: {
  messageId: string;
  conversationId: string;
  meta?: Record<string, unknown>;
}) {
  return {
    channel: CHANNEL_ID as never,
    messageId: params.messageId,
    conversationId: params.conversationId,
    ...(params.meta ? { meta: params.meta } : {}),
  };
}

function extractProviderMessageId(body: unknown): string | undefined {
  const response = body as { result?: { message_id?: string | number }; message_id?: string | number } | null;
  const messageId = response?.result?.message_id ?? response?.message_id;
  return messageId !== undefined ? String(messageId) : undefined;
}

function extractSlackProviderMessageId(body: unknown): string | undefined {
  const response = body as { ts?: string; message?: { ts?: string } } | null;
  return response?.ts ?? response?.message?.ts;
}

function isSlackTarget(target: string): boolean {
  return /^[CDGUAW][A-Z0-9]{4,}$/.test(target.trim());
}

function toPluginLogger(
  logger: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
    debug?: (msg: string) => void;
  } | undefined,
) {
  if (!logger) return undefined;
  return {
    info: (...args: unknown[]) => logger.info?.(args.map(String).join(" ")),
    warn: (...args: unknown[]) => logger.warn?.(args.map(String).join(" ")),
    error: (...args: unknown[]) => logger.error?.(args.map(String).join(" ")),
    ...(logger.debug ? { debug: (...args: unknown[]) => logger.debug?.(args.map(String).join(" ")) } : {}),
  };
}

function buildInitialTelegramProxyRequest(params: {
  to: string;
  text: string;
  threadId?: string | number | null;
  replyToId?: string | null;
  mediaUrl?: string;
}) {
  const body: Record<string, unknown> = {
    chat_id: params.to,
  };

  if (params.threadId !== undefined && params.threadId !== null) {
    body.message_thread_id = params.threadId;
  }
  if (params.replyToId) {
    body.reply_to_message_id = params.replyToId;
  }

  if (params.mediaUrl) {
    body.document = params.mediaUrl;
    body.caption = params.text;
    body.method = "sendDocument";
    return {
      service: "telegram" as const,
      method: "POST" as const,
      url: "https://api.telegram.org/bot/sendDocument",
      body,
      context: {
        tool: "channel_plugin",
        action: "send_media",
        channel: "telegram",
      },
    };
  }

  body.text = params.text;
  return {
    service: "telegram" as const,
    method: "POST" as const,
    url: "https://api.telegram.org/bot/sendMessage",
    body,
    context: {
      tool: "channel_plugin",
      action: "send_message",
      channel: "telegram",
    },
  };
}

export function setAgentHiFiveChannelRuntime(runtime: PluginRuntime): void {
  runtimeRef = runtime;
}

export function getAgentHiFiveChannelRuntime(): PluginRuntime | null {
  return runtimeRef;
}

export function buildAgentHiFiveChannelPlugin(sdk: Pick<OpenClawSdkCoreModule, "createChatChannelPlugin">) {
  return sdk.createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "AgentHiFive",
      selectionLabel: "AgentHiFive Vault Channels",
      docsPath: "/plugins/sdk-channel-plugins",
      blurb: "Vault-mediated Telegram and Slack delivery with policy enforcement and approvals.",
      detailLabel: "Vault-managed Slack and Telegram",
    },
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reply: true,
      media: true,
      edit: true,
      unsend: true,
      threads: true,
      blockStreaming: true,
    },
    config: {
      listAccountIds(cfg) {
        const accounts = getChannelSection(cfg).accounts;
        if (!accounts) return [];
        return Object.keys(accounts);
      },
      resolveAccount,
      defaultAccountId() {
        return DEFAULT_ACCOUNT_ID;
      },
      isEnabled(account) {
        return account.enabled;
      },
      async isConfigured(account) {
        return isConfiguredAccount(account);
      },
      describeAccount(account) {
        return {
          accountId: account.accountId,
          enabled: account.enabled,
          configured: isConfiguredAccount(account),
          dmPolicy: account.dmPolicy,
          allowFrom: account.allowFrom,
          baseUrl: account.baseUrl,
          ...(account.name ? { name: account.name } : {}),
        };
      },
    },
    setup: {
      resolveAccountId({ accountId }) {
        return normalizeAccountId(accountId);
      },
      applyAccountConfig({ cfg, accountId, input }) {
        return applySetupConfig({
          cfg,
          accountId,
          input: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.token ?? input.botToken ?? input.accessToken
              ? { token: input.token ?? input.botToken ?? input.accessToken }
              : {}),
            ...(input.url ?? input.httpUrl ? { url: input.url ?? input.httpUrl } : {}),
            ...(input.userId !== undefined ? { userId: input.userId } : {}),
            ...(input.privateKey !== undefined ? { privateKey: input.privateKey } : {}),
            ...(input.audience !== undefined ? { audience: input.audience } : {}),
          },
        });
      },
      validateInput({ cfg, accountId, input }) {
        const current = resolveAccount(cfg, accountId);
        const hasCurrentAuth = Boolean(current.auth);
        const hasBearer = Boolean(input.token ?? input.botToken ?? input.accessToken);
        const hasAgent = Boolean(input.userId && input.privateKey);
        if (!hasCurrentAuth && !hasBearer && !hasAgent) {
          return "Provide either a vault bearer token or an agent id plus private key.";
        }
        return null;
      },
    },
    gateway: {
      async startAccount(ctx) {
        const key = `${ctx.accountId}`;
        accountResources.get(key)?.stop();

        if (!isConfiguredAccount(ctx.account)) {
          ctx.log?.warn?.(`[agenthifive] account ${ctx.accountId} is not configured; skipping gateway start`);
          return;
        }

        const approvalProxy = await createApprovalProxy(ctx.account);
        const pluginLogger = toPluginLogger(ctx.log);
        const stateDir = resolveStateDir();
        initPendingChannelActions(stateDir, pluginLogger);
        initChannelLifecycleEvents(stateDir, pluginLogger);
        const telegramRuntime = createTelegramChannelRuntime(
          {
            ...(pluginLogger ? { logger: pluginLogger } : {}),
            notify: async (event) => {
              if (event.type === "channel_action_pending_approval") {
                wakeChannelSession(event.sessionKey, summarizeLifecycleWake(event));
              }
            },
          },
        );
        const slackRuntime = createSlackChannelRuntime(
          {
            ...(pluginLogger ? { logger: pluginLogger } : {}),
            notify: async (event) => {
              if (event.type === "channel_action_pending_approval") {
                wakeChannelSession(event.sessionKey, summarizeLifecycleWake(event));
              }
            },
          },
        );
        const abortController = new AbortController();
        const signal = AbortSignal.any([ctx.abortSignal, abortController.signal]);

        void startChannelApprovalWatcher({
          proxy: approvalProxy.proxy,
          ...(pluginLogger ? { logger: pluginLogger } : {}),
          pollIntervalMs: ctx.account.pollIntervalMs,
          complete: (action, signal) => {
            if (action.provider === "slack") {
              return slackRuntime.completePendingAction(approvalProxy.proxy, action, signal);
            }
            return telegramRuntime.completePendingAction(approvalProxy.proxy, action, signal);
          },
          notify: async (event) => {
            wakeChannelSession(event.sessionKey, summarizeLifecycleWake(event));
          },
          signal,
        });

        if (ctx.account.telegramEnabled && ctx.channelRuntime) {
          void startTelegramInboundGateway({
            cfg: ctx.cfg,
            runtime: ctx.channelRuntime,
            proxy: approvalProxy.proxy,
            accountId: ctx.account.accountId,
            ...(pluginLogger ? { logger: pluginLogger } : {}),
            signal,
            stateDir,
          });
        } else if (ctx.account.telegramEnabled && pluginLogger) {
          pluginLogger.warn?.(
            "[agenthifive] channelRuntime unavailable; Telegram inbound dispatch disabled for this account",
          );
        }

        if (ctx.account.slackEnabled && ctx.channelRuntime) {
          void startSlackInboundGateway({
            cfg: ctx.cfg,
            runtime: ctx.channelRuntime,
            proxy: approvalProxy.proxy,
            accountId: ctx.account.accountId,
            ...(pluginLogger ? { logger: pluginLogger } : {}),
            signal,
            stateDir,
          });
        } else if (ctx.account.slackEnabled && pluginLogger) {
          pluginLogger.warn?.(
            "[agenthifive] channelRuntime unavailable; Slack inbound dispatch disabled for this account",
          );
        }

        accountResources.set(key, {
          stop() {
            abortController.abort();
            approvalProxy.stop();
          },
        });
      },
      async stopAccount(ctx) {
        const key = `${ctx.accountId}`;
        accountResources.get(key)?.stop();
        accountResources.delete(key);
      },
    },
  },
  security: {
    dm: {
      channelKey: CHANNEL_ID,
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "balanced",
      approveHint: "Approve this conversation in AgentHiFive before the agent can message it.",
    },
  },
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: CHANNEL_ID as never,
      sendText: async (ctx) => {
        const useSlack = isSlackTarget(ctx.to);
        const summary = useSlack ? `Send Slack message to ${ctx.to}` : `Send Telegram message to ${ctx.to}`;
        const runtime = useSlack ? createSlackChannelRuntime() : createTelegramChannelRuntime();
        const account = resolveAccount(ctx.cfg, ctx.accountId);
        const approvalProxy = await createApprovalProxy(account);

        try {
          const response = await approvalProxy.proxy.execute(
            useSlack
              ? {
                  service: "slack" as const,
                  method: "POST" as const,
                  url: "https://slack.com/api/chat.postMessage",
                  body: {
                    channel: ctx.to,
                    text: ctx.text,
                    ...(ctx.threadId !== undefined ? { thread_ts: String(ctx.threadId) } : {}),
                  },
                  context: {
                    tool: "channel_plugin",
                    action: "send_message",
                    channel: "slack",
                  },
                }
              : buildInitialTelegramProxyRequest({
                  to: ctx.to,
                  text: ctx.text,
                  ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
                  ...(ctx.replyToId !== undefined ? { replyToId: ctx.replyToId } : {}),
                }),
          );
          const result = response.status === 202 && response.blocked?.approvalRequestId
            ? adaptChannelActionResponse(
                {
                  approvalRequired: true,
                  approvalRequestId: response.blocked.approvalRequestId,
                  summary,
                  status: response.status,
                },
                summary,
              )
            : response.blocked
            ? adaptChannelActionResponse(
                {
                  blocked: {
                    reason: response.blocked.reason,
                    policy: response.blocked.policy,
                  },
                  status: response.status,
                },
                summary,
              )
            : adaptChannelActionResponse(
                (() => {
                  const providerMessageId = useSlack
                    ? extractSlackProviderMessageId(response.body)
                    : extractProviderMessageId(response.body);
                  return {
                    status: response.status,
                    body: response.body,
                    ...(providerMessageId ? { providerMessageId } : {}),
                  };
                })(),
                summary,
              );

          if (result.kind === "sent") {
            return buildSyntheticDeliveryResult({
              messageId: result.providerMessageId ?? `msg_${Date.now()}`,
              conversationId: String(ctx.to),
            });
          }

          if (result.kind === "approval_required") {
            await runtime.handleOutboundResult(
              {
                action: "send_message",
                target: useSlack
                  ? {
                      channel: ctx.to,
                      ...(ctx.threadId ? { thread_ts: String(ctx.threadId) } : {}),
                    }
                  : {
                      chat_id: ctx.to,
                      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
                    },
                payload: {
                  text: ctx.text,
                  ...(useSlack
                    ? {}
                    : (ctx.replyToId ? { reply_to_message_id: ctx.replyToId } : {})),
                },
                summary,
              },
              result,
            );
            return buildSyntheticDeliveryResult({
              messageId: `approval_${result.approvalRequestId}`,
              conversationId: String(ctx.to),
              meta: {
                approvalRequired: true,
                approvalRequestId: result.approvalRequestId,
              },
            });
          }

          throw new Error(
            result.kind === "blocked" ? result.reason : result.reason,
          );
        } finally {
          approvalProxy.stop();
        }
      },
      sendMedia: async (ctx) => {
        const useSlack = isSlackTarget(ctx.to);
        const summary = useSlack ? `Send Slack media to ${ctx.to}` : `Send Telegram media to ${ctx.to}`;
        const runtime = useSlack ? createSlackChannelRuntime() : createTelegramChannelRuntime();
        const account = resolveAccount(ctx.cfg, ctx.accountId);
        const approvalProxy = await createApprovalProxy(account);

        try {
          const response = await approvalProxy.proxy.execute(
            useSlack
              ? {
                  service: "slack" as const,
                  method: "POST" as const,
                  url: "https://slack.com/api/chat.postMessage",
                  body: {
                    channel: ctx.to,
                    text: [ctx.text, ctx.mediaUrl].filter(Boolean).join("\n\n"),
                    ...(ctx.threadId !== undefined ? { thread_ts: String(ctx.threadId) } : {}),
                  },
                  context: {
                    tool: "channel_plugin",
                    action: "send_media",
                    channel: "slack",
                  },
                }
              : buildInitialTelegramProxyRequest({
                  to: ctx.to,
                  text: ctx.text,
                  ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
                  ...(ctx.replyToId !== undefined ? { replyToId: ctx.replyToId } : {}),
                  ...(ctx.mediaUrl !== undefined ? { mediaUrl: ctx.mediaUrl } : {}),
                }),
          );
          const result = response.status === 202 && response.blocked?.approvalRequestId
            ? adaptChannelActionResponse(
                {
                  approvalRequired: true,
                  approvalRequestId: response.blocked.approvalRequestId,
                  summary,
                  status: response.status,
                },
                summary,
              )
            : response.blocked
            ? adaptChannelActionResponse(
                {
                  blocked: {
                    reason: response.blocked.reason,
                    policy: response.blocked.policy,
                  },
                  status: response.status,
                },
                summary,
              )
            : adaptChannelActionResponse(
                (() => {
                  const providerMessageId = useSlack
                    ? extractSlackProviderMessageId(response.body)
                    : extractProviderMessageId(response.body);
                  return {
                    status: response.status,
                    body: response.body,
                    ...(providerMessageId ? { providerMessageId } : {}),
                  };
                })(),
                summary,
              );

          if (result.kind === "sent") {
            return buildSyntheticDeliveryResult({
              messageId: result.providerMessageId ?? `msg_${Date.now()}`,
              conversationId: String(ctx.to),
            });
          }

          if (result.kind === "approval_required") {
            await runtime.handleOutboundResult(
              {
                action: "send_media",
                target: useSlack
                  ? {
                      channel: ctx.to,
                      ...(ctx.threadId ? { thread_ts: String(ctx.threadId) } : {}),
                    }
                  : {
                      chat_id: ctx.to,
                      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
                    },
                payload: useSlack
                  ? {
                      file_url: ctx.mediaUrl,
                      text: ctx.text,
                    }
                  : {
                      method: "sendDocument",
                      document: ctx.mediaUrl,
                      caption: ctx.text,
                      ...(ctx.replyToId ? { reply_to_message_id: ctx.replyToId } : {}),
                    },
                summary,
              },
              result,
            );
            return buildSyntheticDeliveryResult({
              messageId: `approval_${result.approvalRequestId}`,
              conversationId: String(ctx.to),
              meta: {
                approvalRequired: true,
                approvalRequestId: result.approvalRequestId,
              },
            });
          }

          throw new Error(
            result.kind === "blocked" ? result.reason : result.reason,
          );
        } finally {
          approvalProxy.stop();
        }
      },
    },
  },
  });
}

export function buildAgentHiFiveSetupPlugin(
  sdk: Pick<OpenClawSdkCoreModule, "defineSetupPluginEntry">,
  plugin: ReturnType<typeof buildAgentHiFiveChannelPlugin>,
) {
  return sdk.defineSetupPluginEntry(plugin);
}
