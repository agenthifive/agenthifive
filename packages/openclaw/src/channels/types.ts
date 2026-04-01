export type Ah5ChannelProvider = "slack" | "telegram";

export type Ah5Attachment = {
  id: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type Ah5InboundEvent = {
  provider: Ah5ChannelProvider;
  eventId: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  text?: string;
  threadId?: string;
  attachments?: Ah5Attachment[];
  receivedAt: string;
  redaction?: {
    piiDetected: boolean;
    redacted: boolean;
  };
  replyTarget: Record<string, unknown>;
};

export type Ah5ChannelAction =
  | "send_message"
  | "send_media"
  | "edit_message"
  | "delete_message";

export type ChannelActionSent = {
  kind: "sent";
  providerMessageId?: string;
};

export type ChannelActionBlocked = {
  kind: "blocked";
  reason: string;
  policy?: string;
};

export type ChannelActionApprovalRequired = {
  kind: "approval_required";
  approvalRequestId: string;
  approvalUrl?: string;
  summary: string;
};

export type ChannelActionFailed = {
  kind: "failed";
  reason: string;
  retryable?: boolean;
};

export type ChannelActionResult =
  | ChannelActionSent
  | ChannelActionBlocked
  | ChannelActionApprovalRequired
  | ChannelActionFailed;

export type PendingChannelActionStatus =
  | "pending"
  | "approved"
  | "sent"
  | "denied"
  | "expired"
  | "failed";

export type PendingChannelAction = {
  id: string;
  provider: Ah5ChannelProvider;
  action: Ah5ChannelAction;
  approvalRequestId: string;
  sessionKey?: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
  summary: string;
  status: PendingChannelActionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ChannelActionPendingApprovalEvent = {
  type: "channel_action_pending_approval";
  provider: Ah5ChannelProvider;
  action: Ah5ChannelAction;
  approvalRequestId: string;
  sessionKey?: string;
  approvalUrl?: string;
  summary: string;
};

export type ChannelActionCompletedEvent = {
  type: "channel_action_completed";
  provider: Ah5ChannelProvider;
  action: Ah5ChannelAction;
  approvalRequestId: string;
  sessionKey?: string;
  status: "sent" | "denied" | "expired" | "failed";
  reason?: string;
};

export type ChannelActionLifecycleEvent =
  | ChannelActionPendingApprovalEvent
  | ChannelActionCompletedEvent;
