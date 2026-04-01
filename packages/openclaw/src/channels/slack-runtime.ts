import type { PluginLogger } from "../pending-approvals.js";
import type { ActionProxy } from "../vault-action-proxy.js";
import type { SlackChannelInfo, SlackMessage } from "../slack-poller.js";
import { addChannelLifecycleEvent } from "./lifecycle-events.js";
import { addPendingChannelAction } from "./pending-actions.js";
import { normalizeSlackInboundEvent } from "./slack.js";
import { completeSlackPendingAction } from "./slack-outbound.js";
import type {
  Ah5InboundEvent,
  ChannelActionLifecycleEvent,
  ChannelActionResult,
  PendingChannelAction,
} from "./types.js";

export type ChannelRuntimeNotifier = (
  event: ChannelActionLifecycleEvent,
) => void | Promise<void>;

export type SlackOutboundRequest = {
  action: PendingChannelAction["action"];
  sessionKey?: string;
  target: PendingChannelAction["target"];
  payload: PendingChannelAction["payload"];
  summary: string;
};

export type SlackChannelRuntimeOpts = {
  logger?: PluginLogger;
  notify?: ChannelRuntimeNotifier;
  now?: () => Date;
};

export type SlackChannelRuntime = {
  normalizeInbound(message: SlackMessage, channelInfo: SlackChannelInfo, senderName?: string): Ah5InboundEvent | null;
  handleOutboundResult(
    request: SlackOutboundRequest,
    result: ChannelActionResult,
  ): Promise<ChannelActionResult>;
  completePendingAction(
    proxy: ActionProxy,
    action: PendingChannelAction,
    signal?: AbortSignal,
  ): Promise<ChannelActionResult>;
};

function createPendingAction(
  request: SlackOutboundRequest,
  approvalRequestId: string,
  now: () => Date,
): PendingChannelAction {
  const timestamp = now().toISOString();
  return {
    id: `sca_${approvalRequestId}`,
    provider: "slack",
    action: request.action,
    approvalRequestId,
    ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
    target: request.target,
    payload: request.payload,
    summary: request.summary,
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createSlackChannelRuntime(
  opts: SlackChannelRuntimeOpts = {},
): SlackChannelRuntime {
  const notify: ChannelRuntimeNotifier = async (event) => {
    addChannelLifecycleEvent(event);
    await opts.notify?.(event);
  };
  const now = opts.now ?? (() => new Date());

  return {
    normalizeInbound(message, channelInfo, senderName): Ah5InboundEvent | null {
      return normalizeSlackInboundEvent({
        message,
        channelInfo,
        ...(senderName !== undefined ? { senderName } : {}),
      });
    },

    async handleOutboundResult(
      request: SlackOutboundRequest,
      result: ChannelActionResult,
    ): Promise<ChannelActionResult> {
      if (result.kind !== "approval_required") {
        return result;
      }

      const pending = createPendingAction(request, result.approvalRequestId, now);
      addPendingChannelAction(pending);

      await notify({
        type: "channel_action_pending_approval",
        provider: "slack",
        action: request.action,
        approvalRequestId: result.approvalRequestId,
        ...(pending.sessionKey ? { sessionKey: pending.sessionKey } : {}),
        summary: result.summary,
        ...(result.approvalUrl ? { approvalUrl: result.approvalUrl } : {}),
      });

      return result;
    },

    async completePendingAction(
      proxy: ActionProxy,
      action: PendingChannelAction,
      signal?: AbortSignal,
    ): Promise<ChannelActionResult> {
      return completeSlackPendingAction(proxy, action, signal);
    },
  };
}
