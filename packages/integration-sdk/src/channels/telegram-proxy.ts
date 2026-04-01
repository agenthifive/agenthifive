/**
 * Proxied Telegram Bot API fetch factory.
 *
 * Wraps a standard fetch to route all Telegram Bot API calls through the
 * AgentHiFive vault proxy. grammY accepts a custom `fetch` via
 * `ApiClientOptions.fetch`, so we just swap in this proxied version.
 *
 * Token handling: Telegram embeds the bot token in the URL path
 * (`/bot<TOKEN>/sendMessage`). The proxy strips the token from the URL
 * and the vault re-injects it server-side, so the token never leaves
 * the vault.
 */

import type { ActionProxy } from "../action-proxy.js";
import type { ProxyRequest } from "../action-proxy.js";

/**
 * Create a fetch-compatible function that routes Telegram Bot API calls
 * through the AgentHiFive vault proxy.
 *
 * Uses `service: "telegram"` for singleton resolution — no connectionId needed.
 *
 * @param proxy - The action proxy to route requests through
 */
export function createProxiedTelegramFetch(proxy: ActionProxy): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const action = classifyTelegramAction(url);

    // Extract headers as plain object
    const headers: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const entry of init.headers) {
          const [k, v] = entry as [string, string];
          headers[k] = v;
        }
      } else {
        Object.assign(headers, init.headers);
      }
    }

    // Parse body
    let body: unknown = undefined;
    if (init?.body !== null && init?.body !== undefined) {
      if (typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      } else if (init.body instanceof Uint8Array || Buffer.isBuffer(init.body)) {
        body = {
          _binary: true,
          data: Buffer.from(init.body).toString("base64"),
          contentType: headers["content-type"] ?? headers["Content-Type"],
        };
      } else {
        body = init.body;
      }
    }

    // Strip bot token from URL — the vault re-injects it server-side.
    const sanitizedUrl = stripBotToken(url);

    // Forward the caller's AbortSignal to the vault proxy.
    const callerSignal = init?.signal ?? undefined;

    const result = await proxy.execute(
      {
        service: "telegram",
        method: method as ProxyRequest["method"],
        url: sanitizedUrl,
        headers,
        body,
        context: {
          tool: "telegram",
          action,
          channel: "telegram",
        },
      },
      callerSignal,
    );

    if (result.blocked) {
      throw new Error(
        `Policy blocked: ${result.blocked.reason} (policy: ${result.blocked.policy})`,
      );
    }

    // Build the response body. The vault already parsed the JSON;
    // we re-serialize it so the caller can parse it again.
    const responseBody = JSON.stringify(result.body);

    // Strip transport-level headers that don't apply to the reconstructed body.
    const safeHeaders: Record<string, string> = {};
    const skipHeaders = new Set([
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
    ]);
    for (const [k, v] of Object.entries(result.headers)) {
      if (!skipHeaders.has(k.toLowerCase())) {
        safeHeaders[k] = v;
      }
    }

    return new Response(responseBody, {
      status: result.status,
      headers: safeHeaders,
    });
  };
}

/**
 * Strip the bot token from a Telegram API URL.
 * Input:  https://api.telegram.org/bot123456:ABC-DEF/sendMessage
 * Output: https://api.telegram.org/bot/sendMessage
 */
function stripBotToken(url: string): string {
  return url.replace(/\/bot[^/]*\//, "/bot/");
}

/**
 * Classify a Telegram Bot API method into a human-readable action
 * for policy evaluation.
 */
function classifyTelegramAction(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const method = pathname.split("/").pop() ?? "unknown";
    const map: Record<string, string> = {
      sendMessage: "send_message",
      sendPhoto: "send_photo",
      sendDocument: "send_document",
      sendVideo: "send_video",
      sendAudio: "send_audio",
      sendVoice: "send_voice",
      sendVideoNote: "send_video_note",
      sendAnimation: "send_animation",
      sendSticker: "send_sticker",
      editMessageText: "edit_message",
      deleteMessage: "delete_message",
      setMessageReaction: "set_reaction",
      getUpdates: "get_updates",
      getMe: "get_me",
      getChat: "get_chat",
      getChatMember: "get_chat_member",
      getChatMemberCount: "get_chat_member_count",
      forwardMessage: "forward_message",
      copyMessage: "copy_message",
      pinChatMessage: "pin_message",
      unpinChatMessage: "unpin_message",
    };
    return map[method] ?? method;
  } catch {
    return "unknown";
  }
}
