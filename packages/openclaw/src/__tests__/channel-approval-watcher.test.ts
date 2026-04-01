import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addPendingChannelAction, initPendingChannelActions, loadPendingChannelActions } from "../../dist/channels/pending-actions.js";
import { checkPendingChannelApprovals } from "../../dist/channels/approval-watcher.js";
import { VaultActionProxy } from "../../dist/vault-action-proxy.js";
import type { ChannelActionLifecycleEvent, PendingChannelAction } from "../../dist/channels/types.js";

describe("channel approval watcher", () => {
  let stateDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-channel-watcher-"));
    initPendingChannelActions(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeAction(overrides: Partial<PendingChannelAction> = {}): PendingChannelAction {
    return {
      id: "act_1",
      provider: "telegram",
      action: "send_message",
      approvalRequestId: "apr_1",
      target: { chat_id: 123 },
      payload: { text: "hello" },
      summary: "Send hello",
      status: "pending",
      createdAt: "2026-03-23T10:00:00.000Z",
      updatedAt: "2026-03-23T10:00:00.000Z",
      ...overrides,
    };
  }

  async function withApprovalStatuses(
    statuses: Record<string, string>,
    run: (proxy: VaultActionProxy) => Promise<void>,
  ): Promise<void> {
    global.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const id = url.split("/").pop() ?? "";
      const status = statuses[id] ?? "pending";
      return new Response(JSON.stringify({ approval: { status } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const proxy = new VaultActionProxy({
      baseUrl: "https://vault.test.example.com",
      auth: { mode: "bearer", token: "ah5t_test" },
      timeoutMs: 5_000,
    });
    await run(proxy);
  }

  it("auto-completes approved actions and emits a sent event", async () => {
    addPendingChannelAction(makeAction());
    const events: ChannelActionLifecycleEvent[] = [];
    let completed = 0;

    await withApprovalStatuses({ apr_1: "approved" }, async (proxy) => {
      await checkPendingChannelApprovals({
        proxy,
        signal: new AbortController().signal,
        complete: async () => {
          completed += 1;
          return { kind: "sent", providerMessageId: "msg_123" };
        },
        notify: (event) => events.push(event),
      });
    });

    assert.equal(completed, 1);
    assert.deepEqual(loadPendingChannelActions(), []);
    assert.deepEqual(events, [
      {
        type: "channel_action_completed",
        provider: "telegram",
        action: "send_message",
        approvalRequestId: "apr_1",
        status: "sent",
      },
    ]);
  });

  it("marks denied actions terminal without completing", async () => {
    addPendingChannelAction(makeAction());
    const events: ChannelActionLifecycleEvent[] = [];

    await withApprovalStatuses({ apr_1: "denied" }, async (proxy) => {
      await checkPendingChannelApprovals({
        proxy,
        signal: new AbortController().signal,
        complete: async () => {
          throw new Error("should not be called");
        },
        notify: (event) => events.push(event),
      });
    });

    assert.deepEqual(loadPendingChannelActions(), []);
    assert.deepEqual(events, [
      {
        type: "channel_action_completed",
        provider: "telegram",
        action: "send_message",
        approvalRequestId: "apr_1",
        status: "denied",
      },
    ]);
  });

  it("marks approved actions as failed if completion fails to send", async () => {
    addPendingChannelAction(makeAction());
    const events: ChannelActionLifecycleEvent[] = [];

    await withApprovalStatuses({ apr_1: "approved" }, async (proxy) => {
      await checkPendingChannelApprovals({
        proxy,
        signal: new AbortController().signal,
        complete: async () => ({ kind: "failed", reason: "telegram send failed", retryable: false }),
        notify: (event) => events.push(event),
      });
    });

    const actions = loadPendingChannelActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.status, "failed");
    assert.deepEqual(events, [
      {
        type: "channel_action_completed",
        provider: "telegram",
        action: "send_message",
        approvalRequestId: "apr_1",
        status: "failed",
        reason: "telegram send failed",
      },
    ]);
  });
});
