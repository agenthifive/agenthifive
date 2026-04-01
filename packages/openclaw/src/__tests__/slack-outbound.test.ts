import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSlackCompletionRequest,
  completeSlackPendingAction,
} from "../../dist/channels/slack-outbound.js";
import type { PendingChannelAction } from "../../dist/channels/types.js";

function makeAction(overrides: Partial<PendingChannelAction> = {}): PendingChannelAction {
  return {
    id: "sca_1",
    provider: "slack",
    action: "send_message",
    approvalRequestId: "apr_1",
    target: { channel: "C123" },
    payload: { text: "Hello Slack" },
    summary: "Send Slack message",
    status: "pending",
    createdAt: "2026-03-23T00:00:00.000Z",
    updatedAt: "2026-03-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("slack outbound completion", () => {
  it("builds a chat.postMessage request with approvalId", () => {
    const request = buildSlackCompletionRequest(makeAction());

    assert.equal(request.service, "slack");
    assert.equal(request.url, "https://slack.com/api/chat.postMessage");
    assert.equal(request.approvalId, "apr_1");
    assert.equal((request.body as { channel: string }).channel, "C123");
  });

  it("completes approved sends and extracts provider message id", async () => {
    const result = await completeSlackPendingAction(
      {
        execute: async (request) => {
          assert.equal(request.approvalId, "apr_1");
          return {
            status: 200,
            headers: {},
            body: { ok: true, ts: "1710000000.000100" },
            auditId: "aud_1",
          };
        },
      },
      makeAction(),
    );

    assert.equal(result.kind, "sent");
    if (result.kind === "sent") {
      assert.equal(result.providerMessageId, "1710000000.000100");
    }
  });
});
