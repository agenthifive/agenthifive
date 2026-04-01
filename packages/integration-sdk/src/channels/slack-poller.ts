/**
 * Lightweight Slack polling loop via AgentHiFive vault.
 *
 * Replaces Socket Mode / Events API for vault-managed Slack deployments.
 * Discovers channels via conversations.list, polls conversations.history
 * via VaultActionProxy with `service: "slack"`, and dispatches each new
 * message via the provided callback.
 *
 * Auto-activated by the vault channel watcher when a Slack connection
 * appears in the vault — no static config needed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionProxy } from "../action-proxy.js";
import type { VaultLogger } from "../config.js";
import { noopLogger } from "../config.js";
import { sleepWithAbort } from "../backoff.js";

const WATERMARK_FILE = "vault-slack-watermarks.json";
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const CHANNEL_REFRESH_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 2_000;
const PER_CHANNEL_INTERVAL_MS = 400;

// Subtypes that represent edits/system events — not new user messages
const SKIP_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "thread_broadcast",
  "bot_add",
  "bot_remove",
  "ekm_access_denied",
  "me_message",
  "tombstone",
  "joiner_notification",
  "slackbot_response",
]);

// ---------------------------------------------------------------------------
// Minimal Slack types (no @slack/web-api dependency)
// ---------------------------------------------------------------------------

export type SlackMessage = {
  type?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: "im" | "mpim" | "channel" | "group";
  files?: Array<{ name: string; url_private: string; mimetype: string }>;
};

export type SlackChannelInfo = {
  id: string;
  name?: string | undefined;
  is_im: boolean;
  is_mpim: boolean;
  is_channel: boolean;
  is_group: boolean;
  user?: string | undefined; // For IMs: the other user's ID
};

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

export type VaultSlackPollerOpts = {
  proxy: ActionProxy;
  signal: AbortSignal;
  onMessage: (
    message: SlackMessage,
    channelInfo: SlackChannelInfo,
    botUserId: string,
  ) => Promise<void>;
  /** Directory for persisting watermark state */
  stateDir: string;
  /** Logger (defaults to no-op) */
  logger?: VaultLogger;
};

export async function startVaultSlackPoller(opts: VaultSlackPollerOpts): Promise<void> {
  const { proxy, signal, onMessage, stateDir } = opts;
  const log = opts.logger ?? noopLogger;
  let backoffMs = BACKOFF_INITIAL_MS;

  // Step 1: Resolve bot user ID via auth.test
  const botUserId = await resolveBotUserId(proxy, signal, log);
  if (!botUserId) {
    log.error("failed to resolve bot user ID — cannot start poller");
    return;
  }
  log.debug?.(`resolved bot user ID: ${botUserId}`);

  // Load persisted watermarks
  const watermarks = loadWatermarks(stateDir);
  let channels: SlackChannelInfo[] = [];
  let lastChannelRefresh = 0;

  log.debug?.("starting vault slack poller");

  while (!signal.aborted) {
    try {
      // Refresh channel list periodically
      const now = Date.now();
      if (now - lastChannelRefresh >= CHANNEL_REFRESH_INTERVAL_MS) {
        const refreshed = await discoverChannels(proxy, signal, log);
        if (refreshed) {
          channels = refreshed;
          lastChannelRefresh = now;
          log.debug?.(`monitoring ${channels.length} channels`);
        }
      }

      if (channels.length === 0) {
        await sleepWithAbort(CHANNEL_REFRESH_INTERVAL_MS, signal);
        continue;
      }

      // Poll each channel
      for (const channel of channels) {
        if (signal.aborted) {
          break;
        }

        const oldest = watermarks.channels[channel.id]?.oldest;
        const messages = await pollChannel(proxy, channel.id, oldest, signal, log);

        if (!messages) {
          continue;
        }

        // messages come oldest-first from conversations.history when reversed
        const sorted = [...messages].toSorted((a, b) => Number(a.ts) - Number(b.ts));

        for (const msg of sorted) {
          // Skip bot's own messages
          if (msg.user === botUserId) {
            continue;
          }

          // Skip system subtypes
          if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) {
            continue;
          }

          // Allow: no subtype (normal message), file_share, bot_message (from other bots)
          if (msg.subtype && msg.subtype !== "file_share" && msg.subtype !== "bot_message") {
            continue;
          }

          // Tag the message with channel info
          msg.channel = channel.id;

          try {
            await onMessage(msg, channel, botUserId);
          } catch (err) {
            log.error(`failed to process message ${msg.ts} in ${channel.id}: ${String(err)}`);
          }
        }

        // Update watermark to the newest message timestamp
        if (sorted.length > 0) {
          const newest = sorted[sorted.length - 1]!;
          watermarks.channels[channel.id] = { oldest: newest.ts };
          saveWatermarks(stateDir, watermarks, log);
        }
      }

      // Reset backoff on successful cycle
      backoffMs = BACKOFF_INITIAL_MS;

      // Adaptive interval: more channels → longer pause between cycles
      const interval = Math.max(MIN_POLL_INTERVAL_MS, channels.length * PER_CHANNEL_INTERVAL_MS);
      await sleepWithAbort(interval, signal);
    } catch (err) {
      if (signal.aborted) {
        break;
      }
      log.error(`poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleepWithAbort(backoffMs, signal);
      backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
    }
  }

  log.info("vault slack poller stopped");
}

// ---------------------------------------------------------------------------
// Bot user ID resolution
// ---------------------------------------------------------------------------

async function resolveBotUserId(
  proxy: ActionProxy,
  signal: AbortSignal,
  log: VaultLogger,
): Promise<string | null> {
  try {
    const result = await proxy.execute(
      {
        service: "slack",
        method: "POST",
        url: "https://slack.com/api/auth.test",
      },
      signal,
    );

    if (result.blocked) {
      log.error(`auth.test blocked by policy: ${result.blocked.reason}`);
      return null;
    }

    const body = result.body as { ok?: boolean; user_id?: string } | null;
    if (!body?.ok || !body.user_id) {
      log.error(`auth.test failed: ${JSON.stringify(body)}`);
      return null;
    }

    return body.user_id;
  } catch (err) {
    log.error(`auth.test request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Channel discovery
// ---------------------------------------------------------------------------

async function discoverChannels(
  proxy: ActionProxy,
  signal: AbortSignal,
  log: VaultLogger,
): Promise<SlackChannelInfo[] | null> {
  try {
    const channels: SlackChannelInfo[] = [];
    let cursor: string | undefined;

    do {
      const params = new URLSearchParams({
        types: "im,public_channel",
        exclude_archived: "true",
        limit: "200",
      });
      if (cursor) {
        params.set("cursor", cursor);
      }

      const result = await proxy.execute(
        {
          service: "slack",
          method: "POST",
          url: `https://slack.com/api/conversations.list?${params.toString()}`,
        },
        signal,
      );

      if (result.blocked) {
        log.error(`conversations.list blocked: ${result.blocked.reason}`);
        return null;
      }

      const data = result.body as {
        ok?: boolean;
        channels?: Array<{
          id: string;
          name?: string;
          is_im?: boolean;
          is_mpim?: boolean;
          is_channel?: boolean;
          is_group?: boolean;
          is_member?: boolean;
          user?: string;
        }>;
        response_metadata?: { next_cursor?: string };
      } | null;

      if (!data?.ok) {
        log.error(`conversations.list failed: ${JSON.stringify(data)}`);
        return null;
      }

      const rawChannels = data.channels ?? [];
      log.info(
        `conversations.list returned ${rawChannels.length} channels (raw): ${JSON.stringify(rawChannels.map((c) => ({ id: c.id, name: c.name, is_im: c.is_im, is_member: c.is_member })))}`,
      );

      for (const ch of rawChannels) {
        const isIm = ch.is_im ?? false;
        const isMember = ch.is_member ?? false;
        if (!isIm && !isMember) {
          continue;
        }

        channels.push({
          id: ch.id,
          name: ch.name,
          is_im: isIm,
          is_mpim: ch.is_mpim ?? false,
          is_channel: ch.is_channel ?? false,
          is_group: ch.is_group ?? false,
          user: ch.user,
        });
      }

      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  } catch (err) {
    log.error(`channel discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-channel polling
// ---------------------------------------------------------------------------

async function pollChannel(
  proxy: ActionProxy,
  channelId: string,
  oldest: string | undefined,
  signal: AbortSignal,
  log: VaultLogger,
): Promise<SlackMessage[] | null> {
  try {
    const params = new URLSearchParams({
      channel: channelId,
      limit: "20",
    });
    if (oldest) {
      params.set("oldest", oldest);
      params.set("inclusive", "false");
    }

    const result = await proxy.execute(
      {
        service: "slack",
        method: "POST",
        url: `https://slack.com/api/conversations.history?${params.toString()}`,
      },
      signal,
    );

    if (result.blocked) {
      log.error(`conversations.history blocked for ${channelId}: ${result.blocked.reason}`);
      return null;
    }

    const data = result.body as {
      ok?: boolean;
      messages?: SlackMessage[];
      error?: string;
    } | null;

    if (!data?.ok) {
      if (data?.error === "channel_not_found" || data?.error === "not_in_channel") {
        return null;
      }
      log.error(`conversations.history failed for ${channelId}: ${JSON.stringify(data)}`);
      return null;
    }

    return data.messages ?? [];
  } catch (err) {
    log.error(
      `conversations.history request failed for ${channelId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Watermark persistence
// ---------------------------------------------------------------------------

type WatermarkState = {
  channels: Record<string, { oldest: string }>;
};

function loadWatermarks(stateDir: string): WatermarkState {
  try {
    const data = readFileSync(join(stateDir, WATERMARK_FILE), "utf-8");
    const parsed = JSON.parse(data) as WatermarkState;
    return { channels: parsed.channels ?? {} };
  } catch {
    return { channels: {} };
  }
}

function saveWatermarks(stateDir: string, state: WatermarkState, log: VaultLogger): void {
  try {
    writeFileSync(join(stateDir, WATERMARK_FILE), JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    log.error(`failed to save watermarks: ${String(err)}`);
  }
}
