import type { ActionProxy, ProxyResponse } from "../vault-action-proxy.js";
import { adaptChannelActionResponse } from "./outbound.js";
import type { ChannelActionResult, PendingChannelAction } from "./types.js";

type SlackTarget = {
  channel?: string;
  thread_ts?: string;
  ts?: string;
};

type SlackPayload = Record<string, unknown> & {
  text?: string;
  file_url?: string;
  ts?: string;
};

function buildSlackMethod(action: PendingChannelAction): string {
  switch (action.action) {
    case "send_message":
      return "chat.postMessage";
    case "send_media":
      return "chat.postMessage";
    case "edit_message":
      return "chat.update";
    case "delete_message":
      return "chat.delete";
    default:
      throw new Error(`Unsupported Slack action: ${action.action}`);
  }
}

function buildSlackBody(target: SlackTarget, payload: SlackPayload, action: PendingChannelAction): Record<string, unknown> {
  const channel = target.channel;
  if (!channel) {
    throw new Error("Slack target missing channel");
  }

  if (action.action === "delete_message") {
    return {
      channel,
      ts: target.ts ?? payload.ts,
    };
  }

  if (action.action === "edit_message") {
    return {
      channel,
      ts: target.ts ?? payload.ts,
      text: payload.text ?? "",
    };
  }

  const text = String(payload.text ?? "");
  const mediaUrl = typeof payload.file_url === "string" ? payload.file_url : undefined;
  const body: Record<string, unknown> = {
    channel,
    text: mediaUrl ? [text, mediaUrl].filter(Boolean).join("\n\n") : text,
  };

  if (target.thread_ts) {
    body.thread_ts = target.thread_ts;
  }

  return body;
}

export function buildSlackCompletionRequest(action: PendingChannelAction) {
  const method = buildSlackMethod(action);
  const body = buildSlackBody(action.target as SlackTarget, action.payload as SlackPayload, action);

  return {
    service: "slack" as const,
    method: "POST" as const,
    url: `https://slack.com/api/${method}`,
    body,
    approvalId: action.approvalRequestId,
    context: {
      tool: "channel_plugin",
      action: action.action,
      channel: "slack",
    },
  };
}

function extractSlackProviderMessageId(response: ProxyResponse): string | undefined {
  const body = response.body as { ts?: string; message?: { ts?: string } } | null;
  return body?.ts ?? body?.message?.ts;
}

export async function completeSlackPendingAction(
  proxy: ActionProxy,
  action: PendingChannelAction,
  signal?: AbortSignal,
): Promise<ChannelActionResult> {
  try {
    const response = await proxy.execute(buildSlackCompletionRequest(action), signal);

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

    const providerMessageId = extractSlackProviderMessageId(response);
    return adaptChannelActionResponse(
      {
        status: response.status,
        body: response.body,
        ...(providerMessageId ? { providerMessageId } : {}),
      },
      action.summary,
    );
  } catch (err) {
    return {
      kind: "failed",
      reason: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}
