import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTelegramCompletionRequest,
  completeTelegramPendingAction,
} from "../../dist/channels/telegram-outbound.js";
import type { PendingChannelAction } from "../../dist/channels/types.js";

function makeAction(overrides: Partial<PendingChannelAction> = {}): PendingChannelAction {
  return {
    id: "act_1",
    provider: "telegram",
    action: "send_message",
    approvalRequestId: "apr_1",
    target: { chat_id: 123, message_thread_id: 55 },
    payload: { text: "hello" },
    summary: "Send hello",
    status: "pending",
    createdAt: "2026-03-23T10:00:00.000Z",
    updatedAt: "2026-03-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("telegram outbound completion", () => {
  it("builds a sendMessage request with approvalId", () => {
    const request = buildTelegramCompletionRequest(makeAction());

    assert.equal(request.service, "telegram");
    assert.equal(request.method, "POST");
    assert.equal(request.url, "https://api.telegram.org/bot/sendMessage");
    assert.equal(request.approvalId, "apr_1");
    assert.deepEqual(request.body, {
      chat_id: 123,
      message_thread_id: 55,
      text: "hello",
    });
  });

  it("builds an editMessageText request", () => {
    const request = buildTelegramCompletionRequest(
      makeAction({
        action: "edit_message",
        target: { chat_id: 123, message_id: 999 },
        payload: { text: "edited" },
      }),
    );

    assert.equal(request.url, "https://api.telegram.org/bot/editMessageText");
    assert.deepEqual(request.body, {
      chat_id: 123,
      message_id: 999,
      text: "edited",
    });
  });

  it("builds a media send request using payload.method", () => {
    const request = buildTelegramCompletionRequest(
      makeAction({
        action: "send_media",
        payload: {
          method: "sendPhoto",
          photo: "file_123",
          caption: "look",
        },
      }),
    );

    assert.equal(request.url, "https://api.telegram.org/bot/sendPhoto");
    assert.deepEqual(request.body, {
      chat_id: 123,
      message_thread_id: 55,
      photo: "file_123",
      caption: "look",
    });
  });

  it("completes approved sends and extracts provider message id", async () => {
    const result = await completeTelegramPendingAction(
      {
        execute: async (request) => {
          assert.equal(request.approvalId, "apr_1");
          return {
            status: 200,
            headers: {},
            body: { result: { message_id: 777 } },
            auditId: "aud_1",
          };
        },
      },
      makeAction(),
    );

    assert.deepEqual(result, {
      kind: "sent",
      providerMessageId: "777",
    });
  });

  it("returns blocked when vault still blocks the completion request", async () => {
    const result = await completeTelegramPendingAction(
      {
        execute: async () => ({
          status: 403,
          headers: {},
          body: null,
          auditId: "aud_2",
          blocked: {
            reason: "Blocked by policy",
            policy: "vault-policy",
          },
        }),
      },
      makeAction(),
    );

    assert.deepEqual(result, {
      kind: "blocked",
      reason: "Blocked by policy",
      policy: "vault-policy",
    });
  });

  it("returns failed when execution throws", async () => {
    const result = await completeTelegramPendingAction(
      {
        execute: async () => {
          throw new Error("network down");
        },
      },
      makeAction(),
    );

    assert.deepEqual(result, {
      kind: "failed",
      reason: "network down",
      retryable: true,
    });
  });
});
