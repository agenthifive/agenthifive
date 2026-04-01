import type { SlackChannelInfo, SlackMessage } from "../slack-poller.js";
import type { Ah5Attachment, Ah5InboundEvent } from "./types.js";

function classifyChatType(channelInfo: SlackChannelInfo): "direct" | "group" | "channel" {
  if (channelInfo.is_im) return "direct";
  if (channelInfo.is_mpim || channelInfo.is_group) return "group";
  return "channel";
}

function collectAttachments(message: SlackMessage): Ah5Attachment[] | undefined {
  const files = message.files?.map((file, index) => ({
    id: file.url_private || `${message.ts}:${index}`,
    ...(file.name ? { name: file.name } : {}),
    ...(file.mimetype ? { mimeType: file.mimetype } : {}),
  })) ?? [];

  return files.length > 0 ? files : undefined;
}

export function normalizeSlackInboundEvent(params: {
  message: SlackMessage;
  channelInfo: SlackChannelInfo;
  senderName?: string;
}): Ah5InboundEvent | null {
  const { message, channelInfo, senderName } = params;
  const text = message.text?.trim() ?? "";
  const attachments = collectAttachments(message);
  const senderId = message.user ?? message.bot_id;

  if (!senderId || (!text && !attachments?.length)) {
    return null;
  }

  return {
    provider: "slack",
    eventId: `slack:${channelInfo.id}:${message.ts}`,
    conversationId: channelInfo.id,
    senderId,
    ...(senderName ? { senderName } : {}),
    ...(text ? { text } : {}),
    ...(message.thread_ts ? { threadId: message.thread_ts } : {}),
    ...(attachments ? { attachments } : {}),
    receivedAt: new Date(Number(message.ts) * 1000).toISOString(),
    replyTarget: {
      channel: channelInfo.id,
      chatType: classifyChatType(channelInfo),
      ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      ...(message.ts ? { reply_to_ts: message.ts } : {}),
    },
  };
}
