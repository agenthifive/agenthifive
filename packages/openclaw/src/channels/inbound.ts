import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { VaultActionProxy } from "../vault-action-proxy.js";
import type { PluginLogger } from "../pending-approvals.js";
import { startSlackPoller, type SlackChannelInfo, type SlackMessage, type SlackPollerOpts } from "../slack-poller.js";
import { importOpenClawReplyPayload } from "../openclaw-host.js";
import { startTelegramPoller, type TelegramMessage, type TelegramPollerOpts } from "../telegram-poller.js";
import { createTelegramChannelRuntime, type TelegramOutboundRequest } from "./channel.js";
import { createSlackChannelRuntime, type SlackOutboundRequest } from "./slack-runtime.js";
import { adaptChannelActionResponse } from "./outbound.js";

const CHANNEL_ID = "agenthifive";

export type TelegramInboundRuntimeDeps = {
  cfg: OpenClawConfig;
  runtime: PluginRuntime["channel"];
  proxy: VaultActionProxy;
  accountId: string;
  logger?: PluginLogger;
  signal: AbortSignal;
};

export type SlackInboundRuntimeDeps = {
  cfg: OpenClawConfig;
  runtime: PluginRuntime["channel"];
  proxy: VaultActionProxy;
  accountId: string;
  logger?: PluginLogger;
  signal: AbortSignal;
};

function extractProviderMessageId(body: unknown): string | undefined {
  const response = body as { result?: { message_id?: string | number }; message_id?: string | number } | null;
  const messageId = response?.result?.message_id ?? response?.message_id;
  return messageId !== undefined ? String(messageId) : undefined;
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

async function sendTelegramReplyViaVault(params: {
  proxy: VaultActionProxy;
  telegramRuntime: ReturnType<typeof createTelegramChannelRuntime>;
  request: TelegramOutboundRequest;
}): Promise<void> {
  const target = params.request.target as {
    chat_id?: string | number;
    message_thread_id?: string | number;
    reply_to_message_id?: string | number;
  };
  const payload = params.request.payload as {
    text?: string;
    caption?: string;
    document?: string;
  };

  const response = await params.proxy.execute(
    buildInitialTelegramProxyRequest({
      to: String(target.chat_id ?? ""),
      text: String(payload.text ?? payload.caption ?? ""),
      ...(target.message_thread_id !== undefined ? { threadId: target.message_thread_id } : {}),
      ...(target.reply_to_message_id !== undefined ? { replyToId: String(target.reply_to_message_id) } : {}),
      ...(payload.document ? { mediaUrl: String(payload.document) } : {}),
    }),
  );

  const result = response.status === 202 && response.blocked?.approvalRequestId
    ? adaptChannelActionResponse(
        {
          approvalRequired: true,
          approvalRequestId: response.blocked.approvalRequestId,
          summary: params.request.summary,
          status: response.status,
        },
        params.request.summary,
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
          params.request.summary,
        )
      : adaptChannelActionResponse(
          (() => {
            const providerMessageId = extractProviderMessageId(response.body);
            return {
              status: response.status,
              body: response.body,
              ...(providerMessageId ? { providerMessageId } : {}),
            };
          })(),
          params.request.summary,
        );

  if (result.kind === "approval_required") {
    await params.telegramRuntime.handleOutboundResult(params.request, result);
    return;
  }

  if (result.kind === "sent") {
    return;
  }

  throw new Error(result.reason);
}

async function resolveSlackSenderName(
  proxy: VaultActionProxy,
  userId: string,
): Promise<string> {
  try {
    const result = await proxy.execute({
      service: "slack",
      method: "POST",
      url: `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
    });
    if (result.blocked) return userId;

    const body = result.body as {
      ok?: boolean;
      user?: { real_name?: string; name?: string; profile?: { display_name?: string } };
    } | null;
    return body?.user?.profile?.display_name
      || body?.user?.real_name
      || body?.user?.name
      || userId;
  } catch {
    return userId;
  }
}

function classifySlackPeer(channelInfo: SlackChannelInfo): "direct" | "group" | "channel" {
  if (channelInfo.is_im) return "direct";
  if (channelInfo.is_mpim || channelInfo.is_group) return "group";
  return "channel";
}

function buildInitialSlackProxyRequest(params: {
  to: string;
  text: string;
  threadTs?: string | null;
  mediaUrl?: string;
}) {
  const body: Record<string, unknown> = {
    channel: params.to,
    text: params.mediaUrl ? [params.text, params.mediaUrl].filter(Boolean).join("\n\n") : params.text,
  };

  if (params.threadTs) {
    body.thread_ts = params.threadTs;
  }

  return {
    service: "slack" as const,
    method: "POST" as const,
    url: "https://slack.com/api/chat.postMessage",
    body,
    context: {
      tool: "channel_plugin",
      action: params.mediaUrl ? "send_media" : "send_message",
      channel: "slack",
    },
  };
}

function extractSlackProviderMessageId(body: unknown): string | undefined {
  const response = body as { ts?: string; message?: { ts?: string } } | null;
  return response?.ts ?? response?.message?.ts;
}

async function sendSlackReplyViaVault(params: {
  proxy: VaultActionProxy;
  slackRuntime: ReturnType<typeof createSlackChannelRuntime>;
  request: SlackOutboundRequest;
}): Promise<void> {
  const target = params.request.target as {
    channel?: string;
    thread_ts?: string;
  };
  const payload = params.request.payload as {
    text?: string;
    file_url?: string;
  };

  const response = await params.proxy.execute(
    buildInitialSlackProxyRequest({
      to: String(target.channel ?? ""),
      text: String(payload.text ?? ""),
      ...(target.thread_ts !== undefined ? { threadTs: target.thread_ts } : {}),
      ...(payload.file_url ? { mediaUrl: String(payload.file_url) } : {}),
    }),
  );

  const result = response.status === 202 && response.blocked?.approvalRequestId
    ? adaptChannelActionResponse(
        {
          approvalRequired: true,
          approvalRequestId: response.blocked.approvalRequestId,
          summary: params.request.summary,
          status: response.status,
        },
        params.request.summary,
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
          params.request.summary,
        )
      : adaptChannelActionResponse(
          (() => {
            const providerMessageId = extractSlackProviderMessageId(response.body);
            return {
              status: response.status,
              body: response.body,
              ...(providerMessageId ? { providerMessageId } : {}),
            };
          })(),
          params.request.summary,
        );

  if (result.kind === "approval_required") {
    await params.slackRuntime.handleOutboundResult(params.request, result);
    return;
  }

  if (result.kind === "sent") {
    return;
  }

  throw new Error(result.reason);
}

export async function handleTelegramInboundMessage(
  message: TelegramMessage,
  deps: TelegramInboundRuntimeDeps,
): Promise<void> {
  const rawBody = message.text?.trim();
  if (!rawBody || !message.from) {
    return;
  }

  const isGroup = message.chat.type !== "private";
  const peerId = String(message.chat.id);
  const senderId = String(message.from.id);
  const senderName = [message.from.first_name, message.from.last_name]
    .filter(Boolean)
    .join(" ")
    .trim() || senderId;
  const fromLabel = isGroup
    ? (message.chat.title?.trim() || `group:${peerId}`)
    : senderName;

  deps.runtime.activity.record({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    direction: "inbound",
    at: message.date * 1000,
  });

  const route = deps.runtime.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: peerId,
    },
  });

  const storePath = deps.runtime.session.resolveStorePath(deps.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelope = deps.runtime.reply.resolveEnvelopeFormatOptions(deps.cfg);
  const previousTimestamp = deps.runtime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = deps.runtime.reply.formatAgentEnvelope({
    channel: "Telegram",
    from: fromLabel,
    timestamp: message.date * 1000,
    envelope,
    body: rawBody,
    ...(previousTimestamp !== undefined ? { previousTimestamp } : {}),
  });

  const ctxPayload = deps.runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: isGroup ? `telegram:group:${peerId}` : `telegram:${senderId}`,
    To: `telegram:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderId,
    ...(isGroup && message.chat.title ? { GroupSubject: message.chat.title } : {}),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(message.message_id),
    Timestamp: message.date * 1000,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `telegram:${peerId}`,
    ...(message.message_thread_id !== undefined
      ? { ThreadId: String(message.message_thread_id) }
      : {}),
  });

  await deps.runtime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      deps.logger?.error?.(`[agenthifive] failed updating Telegram session meta: ${String(err)}`);
    },
  });

  const telegramRuntime = createTelegramChannelRuntime({
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  await deps.runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: deps.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const { deliverTextOrMediaReply } = await importOpenClawReplyPayload();
        await deliverTextOrMediaReply({
          payload,
          text: payload.text ?? "",
          sendText: async (text) => {
            await sendTelegramReplyViaVault({
              proxy: deps.proxy,
              telegramRuntime,
              request: {
                action: "send_message",
                sessionKey: route.sessionKey,
                target: {
                  chat_id: peerId,
                  ...(message.message_thread_id !== undefined
                    ? { message_thread_id: message.message_thread_id }
                    : {}),
                  reply_to_message_id: message.message_id,
                },
                payload: { text },
                summary: `Send Telegram message to ${peerId}`,
              },
            });
            deps.runtime.activity.record({
              channel: CHANNEL_ID,
              accountId: deps.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
          sendMedia: async ({ mediaUrl, caption }) => {
            await sendTelegramReplyViaVault({
              proxy: deps.proxy,
              telegramRuntime,
              request: {
                action: "send_media",
                sessionKey: route.sessionKey,
                target: {
                  chat_id: peerId,
                  ...(message.message_thread_id !== undefined
                    ? { message_thread_id: message.message_thread_id }
                    : {}),
                  reply_to_message_id: message.message_id,
                },
                payload: {
                  method: "sendDocument",
                  document: mediaUrl,
                  ...(caption ? { caption } : {}),
                },
                summary: `Send Telegram media to ${peerId}`,
              },
            });
            deps.runtime.activity.record({
              channel: CHANNEL_ID,
              accountId: deps.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
        });
      },
      onError: (err, info) => {
        deps.logger?.error?.(`[agenthifive] Telegram ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

export function buildTelegramInboundPollerOpts(
  deps: TelegramInboundRuntimeDeps,
  stateDir: string,
): TelegramPollerOpts {
  return {
    proxy: deps.proxy,
    signal: deps.signal,
    stateDir,
    logger: deps.logger ?? console,
    onMessage: async (message) => {
      await handleTelegramInboundMessage(message, deps);
    },
  };
}

export async function startTelegramInboundGateway(
  deps: TelegramInboundRuntimeDeps & { stateDir: string },
): Promise<void> {
  await startTelegramPoller(buildTelegramInboundPollerOpts(deps, deps.stateDir));
}

export async function handleSlackInboundMessage(
  message: SlackMessage,
  channelInfo: SlackChannelInfo,
  deps: SlackInboundRuntimeDeps,
): Promise<void> {
  const rawBody = message.text?.trim() ?? "";
  if ((!rawBody && !message.files?.length) || (!message.user && !message.bot_id)) {
    return;
  }

  const peerId = channelInfo.id;
  const senderId = String(message.user ?? message.bot_id ?? "unknown");
  const senderName = message.user
    ? await resolveSlackSenderName(deps.proxy, message.user)
    : `bot:${message.bot_id ?? "unknown"}`;
  const peerKind = classifySlackPeer(channelInfo);
  const fromLabel = channelInfo.is_im ? senderName : (channelInfo.name?.trim() || peerId);

  deps.runtime.activity.record({
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    direction: "inbound",
    at: Math.round(Number(message.ts) * 1000),
  });

  const route = deps.runtime.routing.resolveAgentRoute({
    cfg: deps.cfg,
    channel: CHANNEL_ID,
    accountId: deps.accountId,
    peer: {
      kind: peerKind,
      id: peerId,
    },
  });

  const storePath = deps.runtime.session.resolveStorePath(deps.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelope = deps.runtime.reply.resolveEnvelopeFormatOptions(deps.cfg);
  const previousTimestamp = deps.runtime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = deps.runtime.reply.formatAgentEnvelope({
    channel: "Slack",
    from: fromLabel,
    timestamp: Math.round(Number(message.ts) * 1000),
    envelope,
    body: rawBody,
    ...(previousTimestamp !== undefined ? { previousTimestamp } : {}),
  });

  const ctxPayload = deps.runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: rawBody,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: channelInfo.is_im ? `slack:${senderId}` : `slack:${peerId}`,
    To: `slack:${peerId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: peerKind,
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: senderId,
    ...(channelInfo.name ? { GroupSubject: channelInfo.name } : {}),
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: String(message.ts),
    Timestamp: Math.round(Number(message.ts) * 1000),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `slack:${peerId}`,
    ...(message.thread_ts !== undefined
      ? { ThreadId: String(message.thread_ts) }
      : {}),
  });

  await deps.runtime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      deps.logger?.error?.(`[agenthifive] failed updating Slack session meta: ${String(err)}`);
    },
  });

  const slackRuntime = createSlackChannelRuntime({
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  await deps.runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: deps.cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const { deliverTextOrMediaReply } = await importOpenClawReplyPayload();
        await deliverTextOrMediaReply({
          payload,
          text: payload.text ?? "",
          sendText: async (text) => {
            await sendSlackReplyViaVault({
              proxy: deps.proxy,
              slackRuntime,
              request: {
                action: "send_message",
                sessionKey: route.sessionKey,
                target: {
                  channel: peerId,
                  ...(message.thread_ts !== undefined ? { thread_ts: message.thread_ts } : {}),
                },
                payload: { text },
                summary: `Send Slack message to ${peerId}`,
              },
            });
            deps.runtime.activity.record({
              channel: CHANNEL_ID,
              accountId: deps.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
          sendMedia: async ({ mediaUrl, caption }) => {
            await sendSlackReplyViaVault({
              proxy: deps.proxy,
              slackRuntime,
              request: {
                action: "send_media",
                sessionKey: route.sessionKey,
                target: {
                  channel: peerId,
                  ...(message.thread_ts !== undefined ? { thread_ts: message.thread_ts } : {}),
                },
                payload: {
                  file_url: mediaUrl,
                  ...(caption ? { text: caption } : {}),
                },
                summary: `Send Slack media to ${peerId}`,
              },
            });
            deps.runtime.activity.record({
              channel: CHANNEL_ID,
              accountId: deps.accountId,
              direction: "outbound",
              at: Date.now(),
            });
          },
        });
      },
      onError: (err, info) => {
        deps.logger?.error?.(`[agenthifive] Slack ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

export function buildSlackInboundPollerOpts(
  deps: SlackInboundRuntimeDeps & { stateDir: string },
): SlackPollerOpts {
  return {
    proxy: deps.proxy,
    signal: deps.signal,
    stateDir: deps.stateDir,
    logger: deps.logger ?? console,
    onMessage: async (message, channelInfo) => {
      await handleSlackInboundMessage(message, channelInfo, deps);
    },
  };
}

export async function startSlackInboundGateway(
  deps: SlackInboundRuntimeDeps & { stateDir: string },
): Promise<void> {
  await startSlackPoller(buildSlackInboundPollerOpts(deps));
}
