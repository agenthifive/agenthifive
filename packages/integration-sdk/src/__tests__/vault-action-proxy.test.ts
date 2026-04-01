import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { VaultActionProxy } from "../../dist/vault-action-proxy.js";

const BASE_URL = "https://vault.test.local";
const DEFAULT_CONFIG = {
  baseUrl: BASE_URL,
  auth: { mode: "api_key" as const, apiKey: "test-key" },
  timeoutMs: 10_000,
};

describe("VaultActionProxy", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = mock.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends execute request with Model B payload", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            status: 200,
            headers: { "content-type": "application/json" },
            body: { ok: true, message: "sent" },
            auditId: "audit-123",
          }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    const result = await proxy.execute({
      connectionId: "conn-uuid",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "hello" },
      context: { tool: "slack_actions", action: "send_message", channel: "slack" },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, message: "sent" });
    assert.equal(result.auditId, "audit-123");
    assert.equal(result.blocked, undefined);

    const callBody = JSON.parse(fetchMock.mock.calls[0]!.arguments[1].body);
    assert.equal(callBody.model, "B");
    assert.equal(callBody.connectionId, "conn-uuid");
    assert.equal(callBody.method, "POST");
    assert.equal(callBody.url, "https://slack.com/api/chat.postMessage");
    assert.deepEqual(callBody.context, {
      tool: "slack_actions",
      action: "send_message",
      channel: "slack",
    });
  });

  it("uses X-API-Key header for api_key auth", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 200, headers: {}, body: null, auditId: "" }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    await proxy.execute({
      connectionId: "conn-uuid",
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/me",
    });

    const headers = fetchMock.mock.calls[0]!.arguments[1].headers;
    assert.equal(headers["X-API-Key"], "test-key");
    assert.equal(headers["Authorization"], undefined);
  });

  it("uses Bearer header for bearer auth", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 200, headers: {}, body: null, auditId: "" }),
      }),
    );

    const proxy = new VaultActionProxy({
      ...DEFAULT_CONFIG,
      auth: { mode: "bearer", token: "jwt-xyz" },
    });
    await proxy.execute({
      connectionId: "conn-uuid",
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/me",
    });

    const headers = fetchMock.mock.calls[0]!.arguments[1].headers;
    assert.equal(headers["Authorization"], "Bearer jwt-xyz");
    assert.equal(headers["X-API-Key"], undefined);
  });

  it("returns blocked result when vault response has blocked field", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            blocked: true,
            reason: "Profanity detected",
            policy: "content-filter",
            auditId: "audit-456",
          }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    const result = await proxy.execute({
      connectionId: "conn-uuid",
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "bad words" },
    });

    assert.ok(result.blocked);
    assert.equal(result.blocked?.reason, "Profanity detected");
    assert.equal(result.blocked?.policy, "content-filter");
    assert.equal(result.auditId, "audit-456");
    assert.equal(result.status, 0);
  });

  it("returns blocked result when vault returns 403", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () =>
          Promise.resolve({
            error: "Action not allowed",
            auditId: "audit-789",
          }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    const result = await proxy.execute({
      connectionId: "conn-uuid",
      method: "DELETE",
      url: "https://slack.com/api/chat.delete",
    });

    assert.ok(result.blocked);
    assert.equal(result.blocked?.reason, "Action not allowed");
    assert.equal(result.blocked?.policy, "vault-policy");
    assert.equal(result.status, 403);
  });

  it("omits context from payload when not provided", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 200, headers: {}, body: null, auditId: "" }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    await proxy.execute({
      connectionId: "conn-uuid",
      method: "GET",
      url: "https://graph.microsoft.com/v1.0/me",
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0]!.arguments[1].body);
    assert.equal(callBody.context, undefined);
  });

  it("passes headers and body through to vault", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 200, headers: {}, body: null, auditId: "" }),
      }),
    );

    const proxy = new VaultActionProxy(DEFAULT_CONFIG);
    await proxy.execute({
      connectionId: "conn-uuid",
      method: "PUT",
      url: "https://graph.microsoft.com/v1.0/me/drive/root:/file.txt:/content",
      headers: { "Content-Type": "text/plain" },
      body: "file contents",
    });

    const callBody = JSON.parse(fetchMock.mock.calls[0]!.arguments[1].body);
    assert.deepEqual(callBody.headers, { "Content-Type": "text/plain" });
    assert.equal(callBody.body, "file contents");
  });
});
