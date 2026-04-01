import type { ActionProxy, ProxyRequest, ProxyResponse } from "../vault-action-proxy.js";
import { adaptChannelActionResponse, channelActionFailed } from "./outbound.js";
import type { ChannelActionResult, PendingChannelAction } from "./types.js";

type TelegramTarget = {
  chat_id?: number | string;
  message_thread_id?: number | string;
  message_id?: number | string;
  inline_message_id?: string;
};

type TelegramMediaPayload = Record<string, unknown> & {
  method?: string;
};

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

function buildTelegramBody(
  target: PendingChannelAction["target"],
  payload: PendingChannelAction["payload"],
): Record<string, unknown> {
  return {
    ...(target as TelegramTarget),
    ...(payload as Record<string, unknown>),
  };
}

function buildTelegramMethod(action: PendingChannelAction): string {
  if (action.action === "send_message") return "sendMessage";
  if (action.action === "edit_message") return "editMessageText";
  if (action.action === "delete_message") return "deleteMessage";

  const payload = action.payload as TelegramMediaPayload;
  if (action.action === "send_media") {
    const method = payload.method;
    if (typeof method === "string" && method.length > 0) {
      return method;
    }
    return "sendDocument";
  }

  throw new Error(`Unsupported Telegram action: ${action.action}`);
}

export function buildTelegramCompletionRequest(
  action: PendingChannelAction,
): ProxyRequest {
  const method = buildTelegramMethod(action);
  const body = buildTelegramBody(action.target, action.payload);
  if ("method" in body) {
    delete body["method"];
  }

  return {
    service: "telegram",
    method: "POST",
    url: `${TELEGRAM_API_BASE}/${method}`,
    body,
    approvalId: action.approvalRequestId,
    context: {
      tool: "channel_plugin",
      action: action.action,
      channel: "telegram",
    },
  };
}

function extractTelegramProviderMessageId(response: ProxyResponse): string | undefined {
  const body = response.body as Record<string, unknown> | null;
  const result = body?.["result"] as Record<string, unknown> | undefined;
  const directMessageId = body?.["message_id"];
  const nestedMessageId = result?.["message_id"];
  const messageId = nestedMessageId ?? directMessageId;
  return messageId !== undefined ? String(messageId) : undefined;
}

export async function completeTelegramPendingAction(
  proxy: ActionProxy,
  action: PendingChannelAction,
  signal?: AbortSignal,
): Promise<ChannelActionResult> {
  try {
    const request = buildTelegramCompletionRequest(action);
    const response = await proxy.execute(request, signal);

    if (response.blocked) {
      return adaptChannelActionResponse(
        {
          blocked: {
            reason: response.blocked.reason,
            policy: response.blocked.policy,
          },
          status: response.status,
        },
        action.summary,
      );
    }

    const providerMessageId = extractTelegramProviderMessageId(response);
    return adaptChannelActionResponse(
      {
        status: response.status,
        body: response.body,
        ...(providerMessageId ? { providerMessageId } : {}),
      },
      action.summary,
    );
  } catch (err) {
    return channelActionFailed(
      err instanceof Error ? err.message : String(err),
      true,
    );
  }
}
