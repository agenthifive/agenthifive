import type { VaultActionProxy } from "../vault-action-proxy.js";
import type { PluginLogger } from "../pending-approvals.js";
import {
  loadPendingChannelActions,
  removePendingChannelAction,
  updatePendingChannelActionStatus,
} from "./pending-actions.js";
import type {
  ChannelActionCompletedEvent,
  ChannelActionLifecycleEvent,
  ChannelActionResult,
  PendingChannelAction,
} from "./types.js";

export type PendingChannelActionCompleter = (
  action: PendingChannelAction,
  signal: AbortSignal,
) => Promise<ChannelActionResult>;

export type ChannelLifecycleNotifier = (
  event: ChannelActionLifecycleEvent,
) => void | Promise<void>;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export type ChannelApprovalWatcherOpts = {
  proxy: VaultActionProxy;
  logger?: PluginLogger;
  signal: AbortSignal;
  pollIntervalMs?: number;
  complete: PendingChannelActionCompleter;
  notify?: ChannelLifecycleNotifier;
};

const DEFAULT_POLL_INTERVAL_MS = 5_000;

type ApprovalStatusResponse = {
  approval?: { status?: string };
  status?: string;
};

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) {
      (timer as NodeJS.Timeout).unref();
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchApprovalStatus(
  proxy: VaultActionProxy,
  approvalRequestId: string,
  signal: AbortSignal,
): Promise<ApprovalStatus | null> {
  const url = `${proxy.baseUrl}/v1/approvals/${approvalRequestId}`;

  const doFetch = () =>
    fetch(url, {
      method: "GET",
      headers: proxy.buildAuthHeader(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
    });

  let response = await doFetch();
  if (response.status === 401) {
    const refreshed = await proxy.refreshToken();
    if (refreshed) {
      response = await doFetch();
    }
  }

  if (!response.ok) return null;

  const body = (await response.json()) as ApprovalStatusResponse;
  const status = body.approval?.status ?? body.status;
  if (
    status === "pending"
    || status === "approved"
    || status === "denied"
    || status === "expired"
    || status === "consumed"
  ) {
    return status;
  }
  return null;
}

function buildCompletedEvent(
  action: PendingChannelAction,
  status: ChannelActionCompletedEvent["status"],
  reason?: string,
): ChannelActionCompletedEvent {
  return {
    type: "channel_action_completed",
    provider: action.provider,
    action: action.action,
    approvalRequestId: action.approvalRequestId,
    ...(action.sessionKey ? { sessionKey: action.sessionKey } : {}),
    status,
    ...(reason ? { reason } : {}),
  };
}

export async function checkPendingChannelApprovals(
  opts: ChannelApprovalWatcherOpts,
): Promise<void> {
  const { proxy, complete, notify, signal } = opts;
  const logger = opts.logger ?? console;
  const actions = loadPendingChannelActions().filter((action) => action.status === "pending");

  for (const action of actions) {
    if (signal.aborted) break;

    try {
      const status = await fetchApprovalStatus(proxy, action.approvalRequestId, signal);
      if (!status || status === "pending") {
        continue;
      }

      if (status === "approved") {
        updatePendingChannelActionStatus(action.approvalRequestId, "approved");
        const result = await complete(action, signal);

        if (result.kind === "sent") {
          updatePendingChannelActionStatus(action.approvalRequestId, "sent");
          removePendingChannelAction(action.approvalRequestId);
          await notify?.(buildCompletedEvent(action, "sent"));
          continue;
        }

        const reason =
          result.kind === "blocked"
            ? result.reason
            : result.kind === "failed"
              ? result.reason
              : "Approval resolved but completion did not send";

        updatePendingChannelActionStatus(action.approvalRequestId, "failed");
        await notify?.(buildCompletedEvent(action, "failed", reason));
        continue;
      }

      if (status === "denied") {
        updatePendingChannelActionStatus(action.approvalRequestId, "denied");
        removePendingChannelAction(action.approvalRequestId);
        await notify?.(buildCompletedEvent(action, "denied"));
        continue;
      }

      if (status === "expired") {
        updatePendingChannelActionStatus(action.approvalRequestId, "expired");
        removePendingChannelAction(action.approvalRequestId);
        await notify?.(buildCompletedEvent(action, "expired"));
        continue;
      }

      if (status === "consumed") {
        updatePendingChannelActionStatus(action.approvalRequestId, "failed");
        removePendingChannelAction(action.approvalRequestId);
        await notify?.(
          buildCompletedEvent(
            action,
            "failed",
            "Approval was already consumed before the plugin could complete the action",
          ),
        );
      }
    } catch (err) {
      logger.error?.(
        `[channel-approval-watcher] failed for ${action.approvalRequestId}: ${String(err)}`,
      );
    }
  }
}

export async function startChannelApprovalWatcher(
  opts: ChannelApprovalWatcherOpts,
): Promise<void> {
  const { signal } = opts;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  while (!signal.aborted) {
    await checkPendingChannelApprovals(opts);
    await sleepWithAbort(pollIntervalMs, signal);
  }
}
