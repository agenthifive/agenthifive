import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normalizeSlackInboundEvent } from "../../dist/channels/slack.js";

describe("normalizeSlackInboundEvent", () => {
  it("normalizes a Slack DM text message", () => {
    const event = normalizeSlackInboundEvent({
      message: {
        ts: "1710000000.000100",
        user: "U123",
        text: "Hello from Slack",
      },
      channelInfo: {
        id: "D123",
        is_im: true,
        is_mpim: false,
        is_channel: false,
        is_group: false,
      },
      senderName: "Alice",
    });

    assert.ok(event);
    assert.equal(event?.provider, "slack");
    assert.equal(event?.conversationId, "D123");
    assert.equal(event?.senderId, "U123");
    assert.equal(event?.senderName, "Alice");
    assert.equal(event?.text, "Hello from Slack");
  });

  it("preserves thread metadata and attachments", () => {
    const event = normalizeSlackInboundEvent({
      message: {
        ts: "1710000001.000100",
        thread_ts: "1710000000.000100",
        user: "U999",
        text: "See file",
        files: [{ name: "spec.pdf", url_private: "https://files", mimetype: "application/pdf" }],
      },
      channelInfo: {
        id: "C123",
        name: "general",
        is_im: false,
        is_mpim: false,
        is_channel: true,
        is_group: false,
      },
      senderName: "Bob",
    });

    assert.ok(event);
    assert.equal(event?.threadId, "1710000000.000100");
    assert.equal(event?.attachments?.[0]?.name, "spec.pdf");
    assert.equal(event?.replyTarget["channel"], "C123");
  });
});
