import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { handleSlackInboundMessage } from "../../dist/channels/inbound.js";
import { initPendingChannelActions, loadPendingChannelActions } from "../../dist/channels/pending-actions.js";
import { initChannelLifecycleEvents, loadChannelLifecycleEvents } from "../../dist/channels/lifecycle-events.js";

describe("Slack inbound runtime", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-slack-inbound-"));
    initPendingChannelActions(stateDir, { info: () => {}, warn: () => {}, error: () => {} });
    initChannelLifecycleEvents(stateDir, { info: () => {}, warn: () => {}, error: () => {} });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeDeps(executeImpl: (request: Record<string, unknown>) => Promise<unknown>) {
    const calls: Record<string, unknown>[] = [];
    const runtime = {
      activity: {
        record: (entry: Record<string, unknown>) => calls.push({ type: "activity", entry }),
      },
      routing: {
        resolveAgentRoute: () => ({
          agentId: "agent_1",
          accountId: "default",
          sessionKey: "sess_slack_1",
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
          await params.dispatcherOptions.deliver({ text: "Slack reply" });
        },
      },
    };

    const proxy = {
      execute: async (request: Record<string, unknown>) => {
        calls.push({ type: "proxy.execute", request });
        return (await executeImpl(request)) as {
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

  it("routes inbound Slack messages through native session and reply dispatch", async () => {
    const { deps, calls } = makeDeps(async (request) => {
      if (String(request.url).includes("users.info")) {
        return {
          status: 200,
          body: { ok: true, user: { profile: { display_name: "Alice" } } },
          headers: {},
          auditId: "aud_user",
        };
      }

      return {
        status: 200,
        body: { ok: true, ts: "1710000000.000200" },
        headers: {},
        auditId: "aud_send",
      };
    });

    await handleSlackInboundMessage(
      {
        ts: "1710000000.000100",
        user: "U123",
        text: "Hello from Slack",
      },
      {
        id: "D123",
        is_im: true,
        is_mpim: false,
        is_channel: false,
        is_group: false,
      },
      deps,
    );

    assert.ok(calls.some((call) => call.type === "recordInboundSession"));
    assert.ok(calls.some((call) => call.type === "dispatchReply"));
    assert.ok(
      calls.some(
        (call) =>
          call.type === "proxy.execute"
          && (call.request as { url?: string }).url === "https://slack.com/api/chat.postMessage",
      ),
    );
    assert.equal(loadPendingChannelActions().length, 0);
  });

  it("stores approval-required Slack replies as pending actions", async () => {
    const { deps } = makeDeps(async (request) => {
      if (String(request.url).includes("users.info")) {
        return {
          status: 200,
          body: { ok: true, user: { profile: { display_name: "Bob" } } },
          headers: {},
          auditId: "aud_user",
        };
      }

      return {
        status: 202,
        blocked: {
          reason: "Approval required",
          policy: "step-up-approval",
          approvalRequestId: "apr_slack_1",
        },
      };
    });

    await handleSlackInboundMessage(
      {
        ts: "1710000000.000100",
        user: "U123",
        text: "Need approval",
      },
      {
        id: "C123",
        name: "general",
        is_im: false,
        is_mpim: false,
        is_channel: true,
        is_group: false,
      },
      deps,
    );

    const pending = loadPendingChannelActions();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.provider, "slack");
    assert.equal(pending[0]?.approvalRequestId, "apr_slack_1");

    const lifecycle = loadChannelLifecycleEvents();
    assert.equal(lifecycle.length, 1);
    assert.equal(lifecycle[0]?.type, "channel_action_pending_approval");
  });
});
