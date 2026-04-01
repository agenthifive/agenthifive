import {
  loadChannelLifecycleEvents,
  saveChannelLifecycleEvents,
} from "./lifecycle-events.js";
import type { ChannelActionLifecycleEvent } from "./types.js";

function renderEvent(event: ChannelActionLifecycleEvent): string {
  if (event.type === "channel_action_pending_approval") {
    return [
      `- ${event.provider} ${event.action} requires approval.`,
      `Approval ID: ${event.approvalRequestId}.`,
      `Summary: ${event.summary}.`,
      ...(event.approvalUrl ? [`Approval URL: ${event.approvalUrl}.`] : []),
      `Tell the user the action is waiting for approval.`,
    ].join(" ");
  }

  if (event.status === "sent") {
    return `- ${event.provider} ${event.action} for approval ${event.approvalRequestId} was sent successfully. Tell the user it has been delivered.`;
  }

  if (event.status === "denied") {
    return `- ${event.provider} ${event.action} for approval ${event.approvalRequestId} was denied by the user. Tell the user it was not sent.`;
  }

  if (event.status === "expired") {
    return `- ${event.provider} ${event.action} for approval ${event.approvalRequestId} expired. Tell the user a fresh approval is needed.`;
  }

  return `- ${event.provider} ${event.action} for approval ${event.approvalRequestId} failed after approval. ${event.reason ? `Reason: ${event.reason}.` : ""} Tell the user the delivery failed.`;
}

export function consumeChannelLifecycleContext(sessionKey?: string): string | null {
  const events = loadChannelLifecycleEvents();
  if (events.length === 0) return null;

  const matched: ChannelActionLifecycleEvent[] = [];
  const remaining: ChannelActionLifecycleEvent[] = [];

  for (const event of events) {
    if (!sessionKey || !event.sessionKey || event.sessionKey === sessionKey) {
      matched.push(event);
    } else {
      remaining.push(event);
    }
  }

  if (matched.length === 0) {
    return null;
  }

  saveChannelLifecycleEvents(remaining);

  return [
    "<vault-channel-updates>",
    "The following vault-managed channel updates occurred since the last turn:",
    ...matched.map(renderEvent),
    "</vault-channel-updates>",
  ].join("\n");
}
