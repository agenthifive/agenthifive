import { request as undiciRequest } from "undici";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";

import { getEncryptionKey } from "./encryption-key";

export interface SlackNotificationPayload {
  channel: string;
  text: string;
  blocks?: unknown[];
}

/**
 * Send a Slack message using a bot connection's encrypted token.
 * Never throws — returns `{ ok: false, error }` on failure.
 */
export async function sendSlackNotification(
  encryptedTokens: string,
  payload: SlackNotificationPayload,
): Promise<{ ok: boolean; error?: string }> {
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
    channel: payload.channel,
    text: payload.text,
  };
  if (payload.blocks) body.blocks = payload.blocks;

  try {
    const res = await undiciRequest(
      "https://slack.com/api/chat.postMessage",
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      },
    );
    const resBody = (await res.body.json()) as { ok: boolean; error?: string };
    return resBody.ok
      ? { ok: true }
      : { ok: false, error: resBody.error ?? "Slack API error" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Send failed" };
  }
}
