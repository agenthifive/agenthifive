/**
 * Lightweight Telegram polling loop via AgentHiFive vault.
 *
 * Replaces grammY for vault-managed Telegram deployments.
 * Calls getUpdates via VaultActionProxy with `service: "telegram"`,
 * parses raw updates, and dispatches each via the provided callback.
 *
 * Auto-activated by the vault channel watcher when a Telegram
 * connection appears in the vault — no static config needed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionProxy } from "../action-proxy.js";
import type { VaultLogger } from "../config.js";
import { noopLogger } from "../config.js";
import { sleepWithAbort } from "../backoff.js";

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
// Poller
// ---------------------------------------------------------------------------

export type VaultTelegramPollerOpts = {
  proxy: ActionProxy;
  signal: AbortSignal;
  onUpdate: (update: TelegramUpdate) => Promise<void>;
  /** Directory for persisting offset state */
  stateDir: string;
  /** Logger (defaults to no-op) */
  logger?: VaultLogger;
};

export async function startVaultTelegramPoller(opts: VaultTelegramPollerOpts): Promise<void> {
  const { proxy, signal, onUpdate, stateDir } = opts;
  const log = opts.logger ?? noopLogger;
  let offset = loadOffset(stateDir);
  let backoffMs = BACKOFF_INITIAL_MS;

  log.info(`starting vault telegram poller (offset=${offset})`);

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
        log.error(`getUpdates blocked by policy: ${result.blocked.reason}`);
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
        continue;
      }

      const body = result.body as { ok?: boolean; result?: TelegramUpdate[] } | null;
      if (!body?.ok || !Array.isArray(body.result)) {
        log.error(`getUpdates unexpected response: ${JSON.stringify(body)}`);
        await sleepWithAbort(backoffMs, signal);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
        continue;
      }

      // Reset backoff on success
      backoffMs = BACKOFF_INITIAL_MS;

      for (const update of body.result) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          log.error(`failed to process update ${update.update_id}: ${String(err)}`);
        }
      }

      // Persist offset after each batch
      if (body.result.length > 0) {
        saveOffset(stateDir, offset, log);
      }
    } catch (err) {
      if (signal.aborted) {
        break;
      }
      log.error(`getUpdates failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleepWithAbort(backoffMs, signal);
      backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
    }
  }

  log.info("vault telegram poller stopped");
}

// ---------------------------------------------------------------------------
// Offset persistence
// ---------------------------------------------------------------------------

function loadOffset(stateDir: string): number {
  try {
    const data = readFileSync(join(stateDir, OFFSET_FILE), "utf-8");
    const parsed = JSON.parse(data) as { offset?: number };
    return parsed.offset ?? 0;
  } catch {
    return 0;
  }
}

function saveOffset(stateDir: string, offset: number, log: VaultLogger): void {
  try {
    writeFileSync(join(stateDir, OFFSET_FILE), JSON.stringify({ offset }, null, 2), "utf-8");
  } catch (err) {
    log.error(`failed to save offset: ${String(err)}`);
  }
}
