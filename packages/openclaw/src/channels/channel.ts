import type { PluginLogger } from "../pending-approvals.js";
import type { ActionProxy } from "../vault-action-proxy.js";
import { addPendingChannelAction } from "./pending-actions.js";
import { addChannelLifecycleEvent } from "./lifecycle-events.js";
import { normalizeTelegramInboundEvent } from "./telegram.js";
import { completeTelegramPendingAction } from "./telegram-outbound.js";
import type {
  Ah5InboundEvent,
  ChannelActionLifecycleEvent,
  ChannelActionResult,
  PendingChannelAction,
} from "./types.js";
import type { TelegramInboundUpdate } from "./telegram.js";

export type ChannelRuntimeNotifier = (
  event: ChannelActionLifecycleEvent,
) => void | Promise<void>;

export type TelegramOutboundRequest = {
  action: PendingChannelAction["action"];
  sessionKey?: string;
  target: PendingChannelAction["target"];
  payload: PendingChannelAction["payload"];
  summary: string;
};

export type TelegramChannelRuntimeOpts = {
  logger?: PluginLogger;
  notify?: ChannelRuntimeNotifier;
  now?: () => Date;
};

export type TelegramChannelRuntime = {
  normalizeInbound(update: TelegramInboundUpdate): Ah5InboundEvent | null;
  handleOutboundResult(
    request: TelegramOutboundRequest,
    result: ChannelActionResult,
  ): Promise<ChannelActionResult>;
  completePendingAction(
    proxy: ActionProxy,
    action: PendingChannelAction,
    signal?: AbortSignal,
  ): Promise<ChannelActionResult>;
};

function createPendingAction(
  request: TelegramOutboundRequest,
  approvalRequestId: string,
  now: () => Date,
): PendingChannelAction {
  const timestamp = now().toISOString();
  return {
    id: `tca_${approvalRequestId}`,
    provider: "telegram",
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

export function createTelegramChannelRuntime(
  opts: TelegramChannelRuntimeOpts = {},
): TelegramChannelRuntime {
  const notify: ChannelRuntimeNotifier = async (event) => {
    addChannelLifecycleEvent(event);
    await opts.notify?.(event);
  };
  const now = opts.now ?? (() => new Date());

  return {
    normalizeInbound(update: TelegramInboundUpdate): Ah5InboundEvent | null {
      return update.message ? normalizeTelegramInboundEvent(update.message, update) : null;
    },

    async handleOutboundResult(
      request: TelegramOutboundRequest,
      result: ChannelActionResult,
    ): Promise<ChannelActionResult> {
      if (result.kind !== "approval_required") {
        return result;
      }

      const pending = createPendingAction(request, result.approvalRequestId, now);
      addPendingChannelAction(pending);

      await notify?.({
        type: "channel_action_pending_approval",
        provider: "telegram",
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
      return completeTelegramPendingAction(proxy, action, signal);
    },
  };
}
