/**
 * Lightweight Telegram polling loop via AgentHiFive vault.
 *
 * Ported from openclaw-fork/src/telegram/vault-poller.ts for use as a plugin.
 * Calls getUpdates via VaultActionProxy with `service: "telegram"`,
 * parses raw updates, and delivers each via the provided callback.
 *
 * Auto-activated by the vault channel watcher when a Telegram
 * connection appears in the vault with botToken: "vault-managed".
 */

import { join } from "node:path";
import { readText, writeText } from "./env-paths.js";
import type { VaultActionProxy } from "./vault-action-proxy.js";
import type { PluginLogger } from "./pending-approvals.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OFFSET_FILE = "vault-telegram-offset.json";
const POLL_TIMEOUT_S = 30;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// Minimal Telegram types (no grammY dependency)
// ---------------------------------------------------------------------------

export type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  is_bot: boolean;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
};

export type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: {
    message_id: number;
    text?: string;
    from?: TelegramUser;
  };
  message_thread_id?: number;
  is_topic_message?: boolean;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

// ---------------------------------------------------------------------------
// Poller options
// ---------------------------------------------------------------------------

export type TelegramPollerOpts = {
  proxy: VaultActionProxy;
  signal: AbortSignal;
  stateDir: string;
  logger: PluginLogger;
  onMessage: (
    message: TelegramMessage,
    update: TelegramUpdate,
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Sleep with abort support
// ---------------------------------------------------------------------------

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Offset persistence
// ---------------------------------------------------------------------------

function loadOffset(stateDir: string): number {
  try {
    const data = readText(join(stateDir, OFFSET_FILE));
    const parsed = JSON.parse(data) as { offset?: number };
    return parsed.offset ?? 0;
  } catch {
    return 0;
  }
}

function saveOffset(stateDir: string, offset: number): void {
  try {
    writeText(join(stateDir, OFFSET_FILE), JSON.stringify({ offset }, null, 2));
  } catch {
    // Non-critical — offset will be re-fetched on restart
  }
}

// ---------------------------------------------------------------------------
// Main poller
// ---------------------------------------------------------------------------

export async function startTelegramPoller(opts: TelegramPollerOpts): Promise<void> {
  const { proxy, signal, stateDir, logger, onMessage } = opts;
  let offset = loadOffset(stateDir);
  let backoffMs = BACKOFF_INITIAL_MS;

  logger.info?.(`[telegram-poller] starting (offset=${offset})`);

  while (!signal.aborted) {
    try {
      const result = await proxy.execute(
        {
          service: "telegram",
          method: "POST",
          url: "https://api.telegram.org/bot/getUpdates",
          body: {
            offset,
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ["message"],
          },
        },
        signal,
      );

      if (result.blocked) {
        logger.error?.(`[telegram-poller] getUpdates blocked: ${result.blocked.reason}`);
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
        continue;
      }

      const body = result.body as { ok?: boolean; error_code?: number; result?: TelegramUpdate[] } | null;

      // 409 = another getUpdates call is active (e.g. external bot instance).
      // With proper subsystem detection, duplicate plugin pollers shouldn't
      // happen — but if they do, or if an external bot is running, back off.
      if (body?.error_code === 409 || result.status === 409) {
        logger.warn?.(`[telegram-poller] 409 Conflict — another bot instance is polling. Will retry.`);
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
        continue;
      }

      if (!body?.ok || !Array.isArray(body.result)) {
        logger.error?.(
          `[telegram-poller] unexpected response (status=${result.status}): ${JSON.stringify(body)?.slice(0, 200)}`,
        );
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
        continue;
      }

      // Reset backoff on success
      backoffMs = BACKOFF_INITIAL_MS;

      if (body.result.length > 0) {
        logger.info?.(`[telegram-poller] received ${body.result.length} update(s)`);
      }

      for (const update of body.result) {
        offset = update.update_id + 1;
        if (update.message) {
          try {
            await onMessage(update.message, update);
          } catch (err) {
            logger.error?.(`[telegram-poller] failed to process update ${update.update_id}: ${String(err)}`);
          }
        }
      }

      // Persist offset after each batch
      if (body.result.length > 0) {
        saveOffset(stateDir, offset);
      }
    } catch (err) {
      if (signal.aborted) break;
      logger.error?.(`[telegram-poller] getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleepWithAbort(backoffMs, signal);
      backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
    }
  }

  logger.info?.(`[telegram-poller] stopped`);
}
