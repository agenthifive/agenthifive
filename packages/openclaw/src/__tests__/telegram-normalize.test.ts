import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeTelegramInboundEvent } from "../../dist/channels/telegram.js";

describe("normalizeTelegramInboundEvent", () => {
  it("normalizes a Telegram DM text message", () => {
    const event = normalizeTelegramInboundEvent(
      {
        message_id: 42,
        from: { id: 123, first_name: "Marco", last_name: "Test" },
        chat: { id: 777, type: "private" },
        date: 1_710_000_000,
        text: "Hello from Telegram",
      },
      { update_id: 99 },
    );

    assert.ok(event);
    assert.equal(event.provider, "telegram");
    assert.equal(event.eventId, "telegram:99");
    assert.equal(event.conversationId, "777");
    assert.equal(event.senderId, "123");
    assert.equal(event.senderName, "Marco Test");
    assert.equal(event.text, "Hello from Telegram");
    assert.deepEqual(event.replyTarget, { chat_id: 777 });
  });

  it("preserves thread metadata for topic messages", () => {
    const event = normalizeTelegramInboundEvent(
      {
        message_id: 7,
        from: { id: 55, first_name: "Topic" },
        chat: { id: -1001, type: "supergroup", title: "Ops" },
        date: 1_710_000_000,
        text: "thread hello",
        message_thread_id: 314,
      },
      { update_id: 100 },
    );

    assert.ok(event);
    assert.equal(event.threadId, "314");
    assert.deepEqual(event.replyTarget, { chat_id: -1001, message_thread_id: 314 });
  });

  it("extracts attachments and caption-only messages", () => {
    const event = normalizeTelegramInboundEvent(
      {
        message_id: 9,
        from: { id: 88, first_name: "Media" },
        chat: { id: 999, type: "group", title: "Group" },
        date: 1_710_000_000,
        caption: "see attached",
        document: {
          file_id: "doc-1",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 2048,
        },
      },
      { update_id: 101 },
    );

    assert.ok(event);
    assert.equal(event.text, "see attached");
    assert.equal(event.attachments?.length, 1);
    assert.deepEqual(event.attachments?.[0], {
      id: "doc-1",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    });
  });

  it("returns null for messages without sender or content", () => {
    assert.equal(
      normalizeTelegramInboundEvent(
        {
          message_id: 1,
          chat: { id: 1, type: "private" },
          date: 1_710_000_000,
        },
        { update_id: 1 },
      ),
      null,
    );
  });
});
