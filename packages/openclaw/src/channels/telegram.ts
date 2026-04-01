import type { Ah5Attachment, Ah5InboundEvent } from "./types.js";

export type TelegramInboundUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

export type TelegramInboundChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
};

export type TelegramInboundAttachment = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TelegramInboundMessage = {
  message_id: number;
  from?: TelegramInboundUser;
  chat: TelegramInboundChat;
  date: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramInboundAttachment[];
  document?: TelegramInboundAttachment;
  video?: TelegramInboundAttachment;
  audio?: TelegramInboundAttachment;
  voice?: TelegramInboundAttachment;
  animation?: TelegramInboundAttachment;
  sticker?: TelegramInboundAttachment;
};

export type TelegramInboundUpdate = {
  update_id: number;
  message?: TelegramInboundMessage;
};

export type TelegramApprovalRequest = {
  summary?: string;
  approvalRequestId: string;
  approvalUrl?: string;
};

function buildSenderName(user?: TelegramInboundUser): string | undefined {
  if (!user) return undefined;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username;
}

function mapAttachment(
  attachment: TelegramInboundAttachment | undefined,
  fallbackName: string,
): Ah5Attachment | null {
  if (!attachment?.file_id) return null;
  return {
    id: attachment.file_id,
    name: attachment.file_name ?? fallbackName,
    ...(attachment.mime_type ? { mimeType: attachment.mime_type } : {}),
    ...(attachment.file_size !== undefined ? { sizeBytes: attachment.file_size } : {}),
  };
}

function collectAttachments(message: TelegramInboundMessage): Ah5Attachment[] | undefined {
  const attachments: Ah5Attachment[] = [];

  if (message.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    const mapped = mapAttachment(largest, "photo");
    if (mapped) attachments.push(mapped);
  }

  for (const [attachment, fallbackName] of [
    [message.document, "document"],
    [message.video, "video"],
    [message.audio, "audio"],
    [message.voice, "voice"],
    [message.animation, "animation"],
    [message.sticker, "sticker"],
  ] as const) {
    const mapped = mapAttachment(attachment, fallbackName);
    if (mapped) attachments.push(mapped);
  }

  return attachments.length > 0 ? attachments : undefined;
}

export function normalizeTelegramInboundEvent(
  message: TelegramInboundMessage,
  update: TelegramInboundUpdate,
): Ah5InboundEvent | null {
  if (!message.from) return null;

  const text = message.text ?? message.caption;
  const attachments = collectAttachments(message);
  const senderName = buildSenderName(message.from);
  if (!text && !attachments?.length) return null;

  const conversationId = String(message.chat.id);
  const replyTarget: Record<string, unknown> = {
    chat_id: message.chat.id,
  };
  if (message.message_thread_id !== undefined) {
    replyTarget["message_thread_id"] = message.message_thread_id;
  }

  return {
    provider: "telegram",
    eventId: `telegram:${update.update_id}`,
    conversationId,
    senderId: String(message.from.id),
    ...(senderName ? { senderName } : {}),
    ...(text ? { text } : {}),
    ...(message.message_thread_id !== undefined
      ? { threadId: String(message.message_thread_id) }
      : {}),
    ...(attachments ? { attachments } : {}),
    receivedAt: new Date(message.date * 1000).toISOString(),
    replyTarget,
  };
}
