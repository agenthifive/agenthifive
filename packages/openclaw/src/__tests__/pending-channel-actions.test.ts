import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addPendingChannelAction,
  getPendingChannelAction,
  initPendingChannelActions,
  loadPendingChannelActions,
  removePendingChannelAction,
  savePendingChannelActions,
  updatePendingChannelActionStatus,
} from "../../dist/channels/pending-actions.js";
import type { PendingChannelAction } from "../../dist/channels/types.js";

describe("pending channel actions", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-channel-actions-"));
    initPendingChannelActions(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
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
      summary: "Send message to Telegram chat 123",
      status: "pending",
      createdAt: "2026-03-23T10:00:00.000Z",
      updatedAt: "2026-03-23T10:00:00.000Z",
      ...overrides,
    };
  }

  it("starts empty", () => {
    assert.deepEqual(loadPendingChannelActions(), []);
  });

  it("saves and loads pending actions", () => {
    savePendingChannelActions([makeAction()]);

    const loaded = loadPendingChannelActions();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.approvalRequestId, "apr_1");
  });

  it("deduplicates by approvalRequestId", () => {
    addPendingChannelAction(makeAction());
    addPendingChannelAction(makeAction({ id: "act_2" }));

    const loaded = loadPendingChannelActions();
    assert.equal(loaded.length, 1);
  });

  it("gets and updates a pending action", () => {
    addPendingChannelAction(makeAction());

    const before = getPendingChannelAction("apr_1");
    assert.ok(before);
    assert.equal(before.status, "pending");

    const updated = updatePendingChannelActionStatus("apr_1", "approved");
    assert.ok(updated);
    assert.equal(updated.status, "approved");

    const after = getPendingChannelAction("apr_1");
    assert.ok(after);
    assert.equal(after.status, "approved");
  });

  it("removes a pending action", () => {
    addPendingChannelAction(makeAction());
    assert.equal(removePendingChannelAction("apr_1"), true);
    assert.equal(removePendingChannelAction("apr_1"), false);
    assert.deepEqual(loadPendingChannelActions(), []);
  });
});
