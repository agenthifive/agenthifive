import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleTelegramInboundMessage } from "../../dist/channels/inbound.js";
import { initPendingChannelActions, loadPendingChannelActions } from "../../dist/channels/pending-actions.js";
import {
  initChannelLifecycleEvents,
  loadChannelLifecycleEvents,
} from "../../dist/channels/lifecycle-events.js";

describe("Telegram inbound runtime", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-telegram-inbound-"));
    initPendingChannelActions(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    initChannelLifecycleEvents(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeDeps(executeImpl: () => Promise<unknown>) {
    const calls: Record<string, unknown>[] = [];
    const runtime = {
      activity: {
        record: (entry: Record<string, unknown>) => {
          calls.push({ type: "activity", entry });
        },
      },
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent_1",
          accountId: "default",
          sessionKey: "sess_1",
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/agent-session",
        readSessionUpdatedAt: () => undefined,
        recordInboundSession: async (params: Record<string, unknown>) => {
          calls.push({ type: "recordInboundSession", params });
        },
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({ style: "default" }),
        formatAgentEnvelope: ({ body }: { body: string }) => `Envelope:${body}`,
        finalizeInboundContext: (ctx: Record<string, unknown>) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: async (params: {
          dispatcherOptions: { deliver: (payload: { text?: string }) => Promise<void> };
        }) => {
          calls.push({ type: "dispatchReply" });
          await params.dispatcherOptions.deliver({ text: "Vault reply" });
        },
      },
    };

    const proxy = {
      execute: async (request: Record<string, unknown>) => {
        calls.push({ type: "proxy.execute", request });
        return (await executeImpl()) as {
          status: number;
          body?: unknown;
          blocked?: { reason: string; policy: string; approvalRequestId?: string };
        };
      },
    };

    return {
      deps: {
        cfg: {},
        runtime: runtime as never,
        proxy: proxy as never,
        accountId: "default",
        signal: new AbortController().signal,
      },
      calls,
    };
  }

  it("routes inbound Telegram messages through native session and reply dispatch", async () => {
    const { deps, calls } = makeDeps(async () => ({
      status: 200,
      body: { result: { message_id: 999 } },
    }));

    await handleTelegramInboundMessage(
      {
        message_id: 42,
        date: 1_710_000_000,
        text: "Hello from Telegram",
        chat: { id: 12345, type: "private" },
        from: { id: 777, first_name: "Alice", is_bot: false },
      },
      deps,
    );

    assert.ok(calls.some((call) => call.type === "recordInboundSession"));
    assert.ok(calls.some((call) => call.type === "dispatchReply"));
    assert.ok(
      calls.some(
        (call) =>
          call.type === "proxy.execute"
          && (call.request as { url?: string }).url === "https://api.telegram.org/bot/sendMessage",
      ),
    );
    assert.equal(loadPendingChannelActions().length, 0);
  });

  it("stores approval-required Telegram replies as pending actions", async () => {
    const { deps } = makeDeps(async () => ({
      status: 202,
      blocked: {
        reason: "Approval required",
        policy: "step-up-approval",
        approvalRequestId: "apr_telegram_1",
      },
    }));

    await handleTelegramInboundMessage(
      {
        message_id: 43,
        date: 1_710_000_001,
        text: "Need approval",
        chat: { id: 2222, type: "private" },
        from: { id: 888, first_name: "Bob", is_bot: false },
      },
      deps,
    );

    const pending = loadPendingChannelActions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.approvalRequestId, "apr_telegram_1");

    const lifecycle = loadChannelLifecycleEvents();
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0]?.type, "channel_action_pending_approval");
  });
});
