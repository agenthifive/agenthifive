import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  addChannelLifecycleEvent,
  consumeChannelLifecycleEvents,
  initChannelLifecycleEvents,
  loadChannelLifecycleEvents,
  saveChannelLifecycleEvents,
} from "../../dist/channels/lifecycle-events.js";
import type { ChannelActionLifecycleEvent } from "../../dist/channels/types.js";

describe("channel lifecycle events", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-channel-events-"));
    initChannelLifecycleEvents(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeEvent(
    overrides: Partial<ChannelActionLifecycleEvent> = {},
  ): ChannelActionLifecycleEvent {
    return {
      type: "channel_action_pending_approval",
      provider: "telegram",
      action: "send_message",
      approvalRequestId: "apr_1",
      summary: "Send hello",
      ...overrides,
    };
  }

  it("starts empty", () => {
    assert.deepEqual(loadChannelLifecycleEvents(), []);
  });

  it("saves and loads lifecycle events", () => {
    saveChannelLifecycleEvents([makeEvent()]);
    const loaded = loadChannelLifecycleEvents();

    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.approvalRequestId, "apr_1");
  });

  it("appends lifecycle events", () => {
    addChannelLifecycleEvent(makeEvent());
    addChannelLifecycleEvent(
      makeEvent({
        type: "channel_action_completed",
        status: "sent",
      }),
    );

    const loaded = loadChannelLifecycleEvents();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]?.type, "channel_action_pending_approval");
    assert.equal(loaded[1]?.type, "channel_action_completed");
  });

  it("consumes and clears events", () => {
    addChannelLifecycleEvent(makeEvent());
    addChannelLifecycleEvent(
      makeEvent({
        type: "channel_action_completed",
        status: "failed",
        reason: "telegram send failed",
      }),
    );

    const consumed = consumeChannelLifecycleEvents();
    assert.equal(consumed.length, 2);
    assert.deepEqual(loadChannelLifecycleEvents(), []);
  });
});
