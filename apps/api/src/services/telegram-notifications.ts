import { request as undiciRequest } from "undici";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";

import { getEncryptionKey } from "./encryption-key";

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{
    text: string;
    url?: string;
  }>>;
}

export interface TelegramEditPayload {
  chatId: string;
  messageId: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboard;
}

export interface TelegramNotificationPayload {
  chatId: string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  replyMarkup?: TelegramInlineKeyboard;
}

/**
 * Send a Telegram message using a bot connection's encrypted token.
 * Never throws — returns `{ ok: false, error }` on failure.
 */
export async function sendTelegramNotification(
  encryptedTokens: string,
  payload: TelegramNotificationPayload,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  let botToken: string;
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    const tokenData = JSON.parse(decrypted) as { botToken?: string };
    if (!tokenData.botToken) {
      return { ok: false, error: "No bot token in connection" };
    }
    botToken = tokenData.botToken;
  } catch {
    return { ok: false, error: "Failed to decrypt bot token" };
  }

  const body: Record<string, unknown> = {
    chat_id: payload.chatId,
    text: payload.text,
  };
  if (payload.parseMode) body.parse_mode = payload.parseMode;
  if (payload.replyMarkup) body.reply_markup = payload.replyMarkup;

  try {
    const res = await undiciRequest(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      },
    );
    const resBody = (await res.body.json()) as { ok: boolean; result?: { message_id?: number }; description?: string };
    if (resBody.ok) {
      const messageId = resBody.result?.message_id;
      return messageId !== undefined ? { ok: true, messageId } : { ok: true };
    }
    return { ok: false, error: resBody.description ?? "Telegram API error" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}

/**
 * Edit an existing Telegram message (e.g. to show approval outcome and remove buttons).
 * Never throws — silently fails if the message can't be edited.
 */
export async function editTelegramMessage(
  encryptedTokens: string,
  payload: TelegramEditPayload,
): Promise<void> {
  let botToken: string;
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    const tokenData = JSON.parse(decrypted) as { botToken?: string };
    if (!tokenData.botToken) return;
    botToken = tokenData.botToken;
  } catch {
    return;
  }

  const body: Record<string, unknown> = {
    chat_id: payload.chatId,
    message_id: payload.messageId,
    text: payload.text,
  };
  if (payload.replyMarkup) body.reply_markup = payload.replyMarkup;

  try {
    await undiciRequest(
      `https://api.telegram.org/bot${botToken}/editMessageText`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      },
    );
  } catch {
    // Ignore — message may have been deleted or bot lost access
  }
}
