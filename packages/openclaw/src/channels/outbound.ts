import type {
  ChannelActionApprovalRequired,
  ChannelActionBlocked,
  ChannelActionFailed,
  ChannelActionResult,
  ChannelActionSent,
} from "./types.js";

export type RawChannelActionResponse = {
  approvalRequired?: boolean;
  approvalRequestId?: string;
  approvalUrl?: string;
  summary?: string;
  blocked?: { reason?: string; policy?: string } | null;
  status?: number;
  auditId?: string;
  body?: unknown;
  providerMessageId?: string;
  error?: string;
};

export function channelActionSent(providerMessageId?: string): ChannelActionSent {
  return {
    kind: "sent",
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

export function channelActionBlocked(reason: string, policy?: string): ChannelActionBlocked {
  return {
    kind: "blocked",
    reason,
    ...(policy ? { policy } : {}),
  };
}

export function channelActionApprovalRequired(
  approvalRequestId: string,
  summary: string,
  approvalUrl?: string,
): ChannelActionApprovalRequired {
  return {
    kind: "approval_required",
    approvalRequestId,
    summary,
    ...(approvalUrl ? { approvalUrl } : {}),
  };
}

export function channelActionFailed(reason: string, retryable?: boolean): ChannelActionFailed {
  return {
    kind: "failed",
    reason,
    ...(retryable !== undefined ? { retryable } : {}),
  };
}

export function adaptChannelActionResponse(
  response: RawChannelActionResponse,
  fallbackSummary: string,
): ChannelActionResult {
  if (response.blocked) {
    return channelActionBlocked(
      response.blocked.reason ?? "Blocked by policy",
      response.blocked.policy,
    );
  }

  if (response.approvalRequired) {
    if (!response.approvalRequestId) {
      return channelActionFailed("Approval was required but no approvalRequestId was returned");
    }
    return channelActionApprovalRequired(
      response.approvalRequestId,
      response.summary ?? fallbackSummary,
      response.approvalUrl,
    );
  }

  if (typeof response.status === "number" && response.status >= 200 && response.status < 300) {
    return channelActionSent(response.providerMessageId);
  }

  return channelActionFailed(
    response.error ?? `Channel action failed with status ${response.status ?? "unknown"}`,
    response.status === undefined || response.status >= 500,
  );
}
