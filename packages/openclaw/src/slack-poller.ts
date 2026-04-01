/**
 * Lightweight Slack polling loop via AgentHiFive vault.
 *
 * Ported from openclaw-fork/src/slack/vault-poller.ts for use as a plugin.
 * Discovers channels via conversations.list, polls conversations.history
 * for new messages, and delivers them via a callback.
 *
 * Thread polling is reactive — threads are only polled when their parent
 * channel had new messages, keeping idle cycles to N_channels API calls.
 */

import { join } from "node:path";
import { readText, writeText, pathExists } from "./env-paths.js";
import type { VaultActionProxy } from "./vault-action-proxy.js";
import type { PluginLogger } from "./pending-approvals.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WATERMARK_FILE = "vault-slack-watermarks.json";
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const CHANNEL_REFRESH_INTERVAL_MS = 60_000;
const MIN_POLL_INTERVAL_MS = 15_000;
const PER_CHANNEL_INTERVAL_MS = 500;
const THREAD_EXPIRY_MS = 30 * 60_000;
const THREAD_MIN_POLL_INTERVAL_MS = 30_000;
const THREAD_POLL_DELAY_MS = 300;

function verbosePollerLogsEnabled(): boolean {
  const raw = process.env["AH5_OPENCLAW_VERBOSE_POLLER_LOGS"];
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function logPollerDebug(logger: PluginLogger, message: string): void {
  if (verbosePollerLogsEnabled()) {
    logger.info?.(message);
  }
}

// Subtypes that represent edits/system events — not new user messages
const SKIP_SUBTYPES = new Set([
  "message_changed", "message_deleted", "message_replied",
  "channel_join", "channel_leave", "channel_topic", "channel_purpose",
  "channel_name", "channel_archive", "channel_unarchive",
  "group_join", "group_leave", "group_topic", "group_purpose",
  "group_name", "group_archive", "group_unarchive",
  "thread_broadcast", "bot_add", "bot_remove", "ekm_access_denied",
  "me_message", "tombstone", "joiner_notification", "slackbot_response",
]);

// ---------------------------------------------------------------------------
// Types
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
  name?: string;
  is_im: boolean;
  is_mpim: boolean;
  is_channel: boolean;
  is_group: boolean;
  user?: string;
};

type TrackedThread = {
  channelId: string;
  threadTs: string;
  lastReplyTs: string;
  trackedAt: number;
  lastPolledAt: number;
};

type WatermarkState = {
  channels: Record<string, { oldest: string }>;
  threads: Record<string, TrackedThread>;
};

export type SlackPollerOpts = {
  proxy: VaultActionProxy;
  signal: AbortSignal;
  stateDir: string;
  logger: PluginLogger;
  onMessage: (
    message: SlackMessage,
    channelInfo: SlackChannelInfo,
    botUserId: string,
  ) => Promise<void>;
};

// ---------------------------------------------------------------------------
// Sleep helper (abortable)
// ---------------------------------------------------------------------------

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer) (timer as NodeJS.Timeout).unref();
    const onAbort = () => { clearTimeout(timer); resolve(); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Message filtering
// ---------------------------------------------------------------------------

function shouldSkipMessage(msg: SlackMessage, botUserId: string): boolean {
  if (msg.user === botUserId) return true;
  if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return true;
  if (msg.subtype && msg.subtype !== "file_share" && msg.subtype !== "bot_message") return true;
  return false;
}

// ---------------------------------------------------------------------------
// Watermark persistence
// ---------------------------------------------------------------------------

function loadWatermarks(stateDir: string, logger: PluginLogger): WatermarkState {
  try {
    const filePath = join(stateDir, WATERMARK_FILE);
    if (!pathExists(filePath)) return { channels: {}, threads: {} };
    const data = readText(filePath);
    const parsed = JSON.parse(data) as WatermarkState;
    for (const thread of Object.values(parsed.threads ?? {})) {
      if (thread.lastPolledAt === undefined) thread.lastPolledAt = 0;
    }
    return { channels: parsed.channels ?? {}, threads: parsed.threads ?? {} };
  } catch (err) {
    logger.error?.(`[slack-poller] failed to load watermarks (resetting): ${String(err)}`);
    return { channels: {}, threads: {} };
  }
}

function saveWatermarks(stateDir: string, state: WatermarkState, logger: PluginLogger): void {
  try {
    writeText(join(stateDir, WATERMARK_FILE), JSON.stringify(state, null, 2));
  } catch (err) {
    logger.error?.(`[slack-poller] failed to save watermarks: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Slack API helpers (via vault proxy)
// ---------------------------------------------------------------------------

async function resolveBotUserId(
  proxy: VaultActionProxy,
  signal: AbortSignal,
  logger: PluginLogger,
): Promise<string | null> {
  try {
    const result = await proxy.execute(
      { service: "slack", method: "POST", url: "https://slack.com/api/auth.test" },
      signal,
    );
    if (result.blocked) {
      logger.error?.(`auth.test blocked: ${result.blocked.reason}`);
      return null;
    }
    const body = result.body as { ok?: boolean; user_id?: string } | null;
    if (!body?.ok || !body.user_id) {
      logger.error?.(`auth.test failed: ${JSON.stringify(body)}`);
      return null;
    }
    return body.user_id;
  } catch (err) {
    logger.error?.(`auth.test request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function discoverChannels(
  proxy: VaultActionProxy,
  signal: AbortSignal,
  logger: PluginLogger,
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
      if (cursor) params.set("cursor", cursor);

      const result = await proxy.execute(
        { service: "slack", method: "POST", url: `https://slack.com/api/conversations.list?${params.toString()}` },
        signal,
      );
      if (result.blocked) {
        logger.error?.(`conversations.list blocked: ${result.blocked.reason}`);
        return null;
      }
      const data = result.body as {
        ok?: boolean;
        channels?: Array<{
          id: string; name?: string; is_im?: boolean; is_mpim?: boolean;
          is_channel?: boolean; is_group?: boolean; is_member?: boolean; user?: string;
        }>;
        response_metadata?: { next_cursor?: string };
      } | null;

      if (!data?.ok) {
        logger.error?.(`conversations.list failed: ${JSON.stringify(data)}`);
        return null;
      }
      for (const ch of data.channels ?? []) {
        const isIm = ch.is_im ?? false;
        if (!isIm && !(ch.is_member ?? false)) continue;
        const info: SlackChannelInfo = {
          id: ch.id, is_im: isIm,
          is_mpim: ch.is_mpim ?? false, is_channel: ch.is_channel ?? false,
          is_group: ch.is_group ?? false,
        };
        if (ch.name != null) info.name = ch.name;
        if (ch.user != null) info.user = ch.user;
        channels.push(info);
      }
      cursor = data.response_metadata?.next_cursor || undefined;
    } while (cursor);

    return channels;
  } catch (err) {
    logger.error?.(`channel discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function pollChannel(
  proxy: VaultActionProxy,
  channelId: string,
  oldest: string | undefined,
  signal: AbortSignal,
  logger: PluginLogger,
): Promise<SlackMessage[] | null> {
  try {
    const params = new URLSearchParams({ channel: channelId, limit: "20" });
    if (oldest) {
      params.set("oldest", oldest);
      params.set("inclusive", "false");
    }
    const result = await proxy.execute(
      { service: "slack", method: "POST", url: `https://slack.com/api/conversations.history?${params.toString()}` },
      signal,
    );
    if (result.blocked) {
      logger.error?.(`[slack-poller] conversations.history blocked for ${channelId}: ${result.blocked.reason}`);
      return null;
    }
    const data = result.body as { ok?: boolean; messages?: SlackMessage[]; error?: string } | null;
    if (!data?.ok) {
      if (data?.error === "channel_not_found" || data?.error === "not_in_channel") return null;
      logger.error?.(`[slack-poller] conversations.history failed for ${channelId}: ${data?.error ?? "unknown"}`);
      return null;
    }
    return data.messages ?? [];
  } catch (err) {
    if (!signal.aborted) {
      logger.error?.(`[slack-poller] conversations.history error for ${channelId}: ${String(err)}`);
    }
    return null;
  }
}

async function pollThread(
  proxy: VaultActionProxy,
  channelId: string,
  threadTs: string,
  oldest: string | undefined,
  signal: AbortSignal,
  logger: PluginLogger,
): Promise<SlackMessage[] | null> {
  try {
    const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: "20" });
    if (oldest) {
      params.set("oldest", oldest);
      params.set("inclusive", "false");
    }
    const result = await proxy.execute(
      { service: "slack", method: "POST", url: `https://slack.com/api/conversations.replies?${params.toString()}` },
      signal,
    );
    if (result.blocked) {
      logger.error?.(`[slack-poller] conversations.replies blocked for ${channelId}:${threadTs}: ${result.blocked.reason}`);
      return null;
    }
    const data = result.body as { ok?: boolean; messages?: SlackMessage[]; error?: string } | null;
    if (!data?.ok) {
      logger.error?.(`[slack-poller] conversations.replies failed for ${channelId}:${threadTs}: ${data?.error ?? "unknown"}`);
      return null;
    }
    return data.messages ?? [];
  } catch (err) {
    if (!signal.aborted) {
      logger.error?.(`[slack-poller] conversations.replies error for ${channelId}:${threadTs}: ${String(err)}`);
    }
    return null;
  }
}

function trackThread(watermarks: WatermarkState, channelId: string, threadTs: string): void {
  const key = `${channelId}:${threadTs}`;
  if (!watermarks.threads[key]) {
    watermarks.threads[key] = {
      channelId, threadTs, lastReplyTs: threadTs,
      trackedAt: Date.now(), lastPolledAt: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Main poller loop
// ---------------------------------------------------------------------------

export async function startSlackPoller(opts: SlackPollerOpts): Promise<void> {
  const { proxy, signal, stateDir, logger, onMessage } = opts;
  let backoffMs = BACKOFF_INITIAL_MS;

  const botUserId = await resolveBotUserId(proxy, signal, logger);
  if (!botUserId) {
    logger.error?.("[slack-poller] failed to resolve bot user ID — cannot start");
    return;
  }
  logPollerDebug(logger, `[slack-poller] bot user ID: ${botUserId}`);

  const watermarks = loadWatermarks(stateDir, logger);
  let channels: SlackChannelInfo[] = [];
  let lastChannelRefresh = 0;

  while (!signal.aborted) {
    try {
      const now = Date.now();

      // Refresh channel list periodically
      if (now - lastChannelRefresh >= CHANNEL_REFRESH_INTERVAL_MS) {
        const refreshed = await discoverChannels(proxy, signal, logger);
        if (refreshed) {
          channels = refreshed;
          lastChannelRefresh = now;
          logPollerDebug(logger, `[slack-poller] monitoring ${channels.length} channels`);

          // Seed watermarks for newly discovered channels — set to "now" so we
          // only deliver messages that arrive AFTER the poller starts. Without this,
          // first startup would flood the agent with every historical message.
          for (const channel of channels) {
            if (!watermarks.channels[channel.id]) {
              watermarks.channels[channel.id] = { oldest: String(Date.now() / 1000) };
              logPollerDebug(logger, `[slack-poller] seeded watermark for ${channel.name ?? channel.id}`);
            }
          }
          saveWatermarks(stateDir, watermarks, logger);
        }
      }

      if (channels.length === 0) {
        await sleepWithAbort(CHANNEL_REFRESH_INTERVAL_MS, signal);
        continue;
      }

      const activeChannelIds = new Set<string>();

      // Poll each channel
      for (const channel of channels) {
        if (signal.aborted) break;
        const oldest = watermarks.channels[channel.id]?.oldest;
        const messages = await pollChannel(proxy, channel.id, oldest, signal, logger);
        if (!messages || messages.length === 0) continue;

        activeChannelIds.add(channel.id);
        const sorted = [...messages].slice().sort((a: SlackMessage, b: SlackMessage) => Number(a.ts) - Number(b.ts));

        for (const msg of sorted) {
          if (shouldSkipMessage(msg, botUserId)) continue;
          msg.channel = channel.id;
          try {
            await onMessage(msg, channel, botUserId);
            trackThread(watermarks, channel.id, msg.ts);
          } catch (err) {
            logger.error?.(`[slack-poller] dispatch failed for ${msg.ts}: ${String(err)}`);
          }
        }

        if (sorted.length > 0) {
          watermarks.channels[channel.id] = { oldest: sorted[sorted.length - 1]!.ts };
          saveWatermarks(stateDir, watermarks, logger);
        }
      }

      // Reactive thread polling
      const now2 = Date.now();
      for (const [key, thread] of Object.entries(watermarks.threads)) {
        if (signal.aborted) break;
        if (now2 - thread.trackedAt > THREAD_EXPIRY_MS) {
          delete watermarks.threads[key];
          continue;
        }
        if (!activeChannelIds.has(thread.channelId)) continue;
        if (thread.lastPolledAt && now2 - thread.lastPolledAt < THREAD_MIN_POLL_INTERVAL_MS) continue;

        const replies = await pollThread(proxy, thread.channelId, thread.threadTs, thread.lastReplyTs, signal, logger);
        thread.lastPolledAt = now2;
        if (!replies || replies.length === 0) continue;

        const chInfo = channels.find((c) => c.id === thread.channelId);
        if (!chInfo) continue;

        const sortedReplies = [...replies].slice().sort((a: SlackMessage, b: SlackMessage) => Number(a.ts) - Number(b.ts));
        let newestReplyTs = thread.lastReplyTs;

        for (const reply of sortedReplies) {
          if (reply.ts === thread.threadTs) continue;
          if (reply.user === botUserId) continue;
          if (reply.subtype && SKIP_SUBTYPES.has(reply.subtype)) continue;
          if (reply.subtype && reply.subtype !== "file_share" && reply.subtype !== "bot_message") continue;

          reply.channel = thread.channelId;
          reply.thread_ts = thread.threadTs;
          try {
            await onMessage(reply, chInfo, botUserId);
          } catch (err) {
            logger.error?.(`[slack-poller] thread reply dispatch failed: ${String(err)}`);
          }
          if (Number(reply.ts) > Number(newestReplyTs)) newestReplyTs = reply.ts;
        }

        if (newestReplyTs !== thread.lastReplyTs) {
          thread.lastReplyTs = newestReplyTs;
          thread.trackedAt = now2;
          saveWatermarks(stateDir, watermarks, logger);
        }
        await sleepWithAbort(THREAD_POLL_DELAY_MS, signal);
      }

      backoffMs = BACKOFF_INITIAL_MS;
      const interval = Math.max(MIN_POLL_INTERVAL_MS, channels.length * PER_CHANNEL_INTERVAL_MS);
      await sleepWithAbort(interval, signal);
    } catch (err) {
      if (signal.aborted) break;
      logger.error?.(`[slack-poller] poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      await sleepWithAbort(backoffMs, signal);
      backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
    }
  }

  logPollerDebug(logger, "[slack-poller] stopped");
}
