import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ActionProxy, ProxyResponse } from "../../dist/action-proxy.js";
import { createProxiedSlackWebClient } from "../../dist/channels/slack-proxy.js";

function makeMockProxy(executeFn: ActionProxy["execute"]): ActionProxy {
  return { execute: executeFn };
}

function makeMockClient() {
  return {
    apiCall: mock.fn(() => Promise.resolve({ ok: true })),
  } as unknown as import("@slack/web-api").WebClient;
}

function makeOkResponse(body: unknown = { ok: true }): ProxyResponse {
  return { status: 200, headers: {}, body, auditId: "audit-1" };
}

describe("createProxiedSlackWebClient", () => {
  it("overrides apiCall to route through proxy", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse({ ok: true, ts: "1234.5678" })),
    );
    const proxy = makeMockProxy(mockExecute);
    const client = createProxiedSlackWebClient(proxy, makeMockClient());

    const result = await client.apiCall("chat.postMessage", {
      channel: "C123",
      text: "hello",
    });

    assert.equal(mockExecute.mock.callCount(), 1);
    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.service, "slack");
    assert.equal(callArgs.method, "POST");
    assert.equal(callArgs.url, "https://slack.com/api/chat.postMessage");
    assert.deepEqual(callArgs.body, { channel: "C123", text: "hello" });
    assert.deepEqual(callArgs.context, {
      tool: "slack_actions",
      action: "send_message",
      channel: "slack",
    });
    assert.deepEqual(result, { ok: true, ts: "1234.5678" });
  });

  it("throws when proxy blocks the action", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve({
        status: 0,
        headers: {},
        body: null,
        auditId: "audit-2",
        blocked: { reason: "Profanity detected", policy: "content-filter" },
      }),
    );
    const proxy = makeMockProxy(mockExecute);
    const client = createProxiedSlackWebClient(proxy, makeMockClient());

    await assert.rejects(
      () => client.apiCall("chat.postMessage", { channel: "C123", text: "bad" }),
      (err: Error) => {
        assert.match(err.message, /Policy blocked: Profanity detected/);
        return true;
      },
    );
  });

  it("classifies known Slack methods into action names", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse()),
    );
    const proxy = makeMockProxy(mockExecute);
    const client = createProxiedSlackWebClient(proxy, makeMockClient());

    const methods: [string, string][] = [
      ["chat.postMessage", "send_message"],
      ["chat.delete", "delete_message"],
      ["reactions.add", "add_reaction"],
      ["files.uploadV2", "upload_file"],
      ["conversations.history", "read_messages"],
    ];

    for (const [method, expectedAction] of methods) {
      await client.apiCall(method);
      const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1]!.arguments[0];
      assert.equal(lastCall.context.action, expectedAction);
    }
  });

  it("uses method name as action fallback for unknown methods", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse()),
    );
    const proxy = makeMockProxy(mockExecute);
    const client = createProxiedSlackWebClient(proxy, makeMockClient());

    await client.apiCall("admin.custom.method");

    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.context.action, "admin_custom.method");
  });
});
