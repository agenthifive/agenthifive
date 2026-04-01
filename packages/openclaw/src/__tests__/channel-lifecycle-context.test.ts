import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { addChannelLifecycleEvent, initChannelLifecycleEvents, loadChannelLifecycleEvents } from "../../dist/channels/lifecycle-events.js";
import { consumeChannelLifecycleContext } from "../../dist/channels/lifecycle-context.js";

describe("channel lifecycle context", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-channel-lifecycle-context-"));
    initChannelLifecycleEvents(stateDir, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("renders pending approval guidance and consumes only matching session events", () => {
    addChannelLifecycleEvent({
      type: "channel_action_pending_approval",
      provider: "telegram",
      action: "send_message",
      approvalRequestId: "apr_1",
      sessionKey: "sess_1",
      summary: "Send hello",
    });
    addChannelLifecycleEvent({
      type: "channel_action_completed",
      provider: "telegram",
      action: "send_message",
      approvalRequestId: "apr_2",
      sessionKey: "sess_2",
      status: "sent",
    });

    const context = consumeChannelLifecycleContext("sess_1");
    assert.ok(context?.includes("requires approval"));
    assert.ok(context?.includes("Tell the user the action is waiting for approval."));

    const remaining = loadChannelLifecycleEvents();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.approvalRequestId, "apr_2");
  });

  it("renders completion outcomes", () => {
    addChannelLifecycleEvent({
      type: "channel_action_completed",
      provider: "telegram",
      action: "send_message",
      approvalRequestId: "apr_3",
      sessionKey: "sess_3",
      status: "denied",
    });

    const context = consumeChannelLifecycleContext("sess_3");
    assert.ok(context?.includes("was denied by the user"));
    assert.deepEqual(loadChannelLifecycleEvents(), []);
  });

  it("renders expired and failed outcomes with actionable guidance", () => {
    addChannelLifecycleEvent({
      type: "channel_action_completed",
      provider: "slack",
      action: "send_message",
      approvalRequestId: "apr_4",
      sessionKey: "sess_4",
      status: "expired",
    });
    addChannelLifecycleEvent({
      type: "channel_action_completed",
      provider: "telegram",
      action: "send_media",
      approvalRequestId: "apr_5",
      sessionKey: "sess_4",
      status: "failed",
      reason: "telegram send failed",
    });

    const context = consumeChannelLifecycleContext("sess_4");
    assert.ok(context?.includes("expired"));
    assert.ok(context?.includes("fresh approval is needed"));
    assert.ok(context?.includes("delivery failed"));
    assert.ok(context?.includes("telegram send failed"));
    assert.deepEqual(loadChannelLifecycleEvents(), []);
  });

  it("leaves unmatched session events queued", () => {
    addChannelLifecycleEvent({
      type: "channel_action_pending_approval",
      provider: "slack",
      action: "send_message",
      approvalRequestId: "apr_6",
      sessionKey: "sess_other",
      summary: "Send update",
    });

    const context = consumeChannelLifecycleContext("sess_current");
    assert.equal(context, null);

    const remaining = loadChannelLifecycleEvents();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.approvalRequestId, "apr_6");
  });
});
