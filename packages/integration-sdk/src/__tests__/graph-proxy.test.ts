import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { ActionProxy, ProxyResponse } from "../../dist/action-proxy.js";
import { createProxiedGraphFetch } from "../../dist/channels/graph-proxy.js";

function makeMockProxy(executeFn: ActionProxy["execute"]): ActionProxy {
  return { execute: executeFn };
}

function makeOkResponse(body: unknown = {}): ProxyResponse {
  return { status: 200, headers: { "content-type": "application/json" }, body, auditId: "" };
}

describe("createProxiedGraphFetch", () => {
  it("returns a fetch function", () => {
    const proxy = makeMockProxy(mock.fn());
    const result = createProxiedGraphFetch(proxy, "conn-uuid");
    assert.equal(typeof result, "function");
  });

  it("routes GET requests through the proxy", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse({ value: [{ id: "user1" }] })),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");
    const response = await proxiedFetch(
      "https://graph.microsoft.com/v1.0/me/chats/chat-id/members",
    );

    assert.equal(mockExecute.mock.callCount(), 1);
    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.connectionId, "conn-uuid");
    assert.equal(callArgs.method, "GET");
    assert.equal(callArgs.url, "https://graph.microsoft.com/v1.0/me/chats/chat-id/members");
    assert.equal(callArgs.context?.action, "get_chat_members");

    const body = await response.json();
    assert.deepEqual(body, { value: [{ id: "user1" }] });
    assert.equal(response.status, 200);
  });

  it("routes PUT requests (file uploads) through the proxy", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(
        makeOkResponse({ id: "item-id", webUrl: "https://sharepoint.com/file", name: "test.txt" }),
      ),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");
    await proxiedFetch(
      "https://graph.microsoft.com/v1.0/sites/site-id/drive/root:/OpenClawShared/test.txt:/content",
      {
        method: "PUT",
        headers: { "Content-Type": "text/plain", Authorization: "Bearer token" },
        body: "file contents",
      },
    );

    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.method, "PUT");
    assert.equal(callArgs.context?.action, "upload_file");
    assert.equal(callArgs.headers?.["Content-Type"], "text/plain");
  });

  it("throws when proxy blocks the action", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve({
        status: 0,
        headers: {},
        body: null,
        auditId: "audit-3",
        blocked: { reason: "File type not allowed", policy: "file-extension-filter" },
      }),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");
    await assert.rejects(
      () =>
        proxiedFetch(
          "https://graph.microsoft.com/v1.0/sites/site-id/drive/root:/file.exe:/content",
          { method: "PUT" },
        ),
      (err: Error) => {
        assert.match(err.message, /Policy blocked: File type not allowed/);
        return true;
      },
    );
  });

  it("classifies Graph API URLs into correct actions", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse()),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");

    const urlActions: [string, string, string][] = [
      ["https://graph.microsoft.com/v1.0/me/drive/root:/file.txt:/content", "PUT", "upload_file"],
      [
        "https://graph.microsoft.com/v1.0/sites/s/drive/items/i/createLink",
        "POST",
        "create_sharing_link",
      ],
      ["https://graph.microsoft.com/v1.0/sites/s/drive/items/i", "GET", "get_drive_item"],
      ["https://graph.microsoft.com/v1.0/chats/c/members", "GET", "get_chat_members"],
      ["https://graph.microsoft.com/v1.0/me/chats/c/messages/m", "GET", "get_message"],
      ["https://graph.microsoft.com/v1.0/groups", "GET", "list_teams"],
      ["https://graph.microsoft.com/v1.0/teams/t/channels", "GET", "list_channels"],
      ["https://graph.microsoft.com/v1.0/users?$search=name", "GET", "search_users"],
    ];

    for (const [url, method, expectedAction] of urlActions) {
      await proxiedFetch(url, { method });
      const lastCall = mockExecute.mock.calls[mockExecute.mock.calls.length - 1]!.arguments[0];
      assert.equal(lastCall.context?.action, expectedAction);
    }
  });

  it("extracts headers from Headers object", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse()),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");
    const headers = new Headers();
    headers.set("Authorization", "Bearer token-123");
    headers.set("Content-Type", "application/json");

    await proxiedFetch("https://graph.microsoft.com/v1.0/me", { headers });

    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.headers?.["authorization"], "Bearer token-123");
    assert.equal(callArgs.headers?.["content-type"], "application/json");
  });

  it("handles binary body by encoding as base64", async () => {
    const mockExecute = mock.fn((): Promise<ProxyResponse> =>
      Promise.resolve(makeOkResponse({ id: "item-id" })),
    );
    const proxy = makeMockProxy(mockExecute);

    const proxiedFetch = createProxiedGraphFetch(proxy, "conn-uuid");
    const buffer = Buffer.from("binary content");

    await proxiedFetch(
      "https://graph.microsoft.com/v1.0/me/drive/root:/file.bin:/content",
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      },
    );

    const callArgs = mockExecute.mock.calls[0]!.arguments[0];
    assert.equal(callArgs.body._binary, true);
    assert.equal(callArgs.body.data, buffer.toString("base64"));
    assert.equal(callArgs.body.contentType, "application/octet-stream");
  });
});
