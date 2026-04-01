import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramChannelRuntime } from "../../dist/channels/channel.js";
import { consumeChannelLifecycleEvents, initChannelLifecycleEvents } from "../../dist/channels/lifecycle-events.js";
import { getPendingChannelAction, initPendingChannelActions } from "../../dist/channels/pending-actions.js";
import type { ChannelActionLifecycleEvent } from "../../dist/channels/types.js";

describe("createTelegramChannelRuntime", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-telegram-runtime-"));
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

  it("stores approval-gated outbound actions and emits a pending event", async () => {
    const events: ChannelActionLifecycleEvent[] = [];
    const runtime = createTelegramChannelRuntime({
      notify: (event) => events.push(event),
      now: () => new Date("2026-03-23T12:00:00.000Z"),
    });

    const result = await runtime.handleOutboundResult(
      {
        action: "send_message",
        target: { chat_id: 123 },
        payload: { text: "hello" },
        summary: "Send hello",
      },
      {
        kind: "approval_required",
        approvalRequestId: "apr_123",
        approvalUrl: "https://app.agenthifive.test/a/apr_123",
        summary: "Send hello",
      },
    );

    assert.equal(result.kind, "approval_required");

    const pending = getPendingChannelAction("apr_123");
    assert.ok(pending);
    assert.equal(pending.provider, "telegram");
    assert.equal(pending.status, "pending");
    assert.deepEqual(events, [
      {
        type: "channel_action_pending_approval",
        provider: "telegram",
        action: "send_message",
        approvalRequestId: "apr_123",
        approvalUrl: "https://app.agenthifive.test/a/apr_123",
        summary: "Send hello",
      },
    ]);
    assert.deepEqual(consumeChannelLifecycleEvents(), events);
  });

  it("passes through non-approval results unchanged", async () => {
    const runtime = createTelegramChannelRuntime();
    const result = await runtime.handleOutboundResult(
      {
        action: "send_message",
        target: { chat_id: 123 },
        payload: { text: "hello" },
        summary: "Send hello",
      },
      { kind: "sent", providerMessageId: "msg_1" },
    );

    assert.deepEqual(result, { kind: "sent", providerMessageId: "msg_1" });
    assert.equal(getPendingChannelAction("apr_missing"), null);
  });
});
