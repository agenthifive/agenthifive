import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VaultClient } from "../../dist/client.js";
import { execute, approvalRequest, approvalCommit } from "../../dist/tools.js";
import { setCurrentSessionContext } from "../../dist/session-context.js";

/**
 * Creates a mock Vault HTTP server for testing.
 */
function createMockVault(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ server: typeof server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to get server address");
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("execute", () => {
  let server: ReturnType<typeof createServer>;
  let client: VaultClient;

  afterEach(() => {
    if (server) server.close();
  });

  it("sends Model B execute request and returns response data + auditId", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/vault/execute");
      const body = JSON.parse(await readBody(req));
      assert.equal(body.model, "B");
      assert.equal(body.connectionId, "conn_123");
      assert.equal(body.method, "GET");
      assert.equal(body.url, "https://www.googleapis.com/gmail/v1/users/me/messages");

      jsonResponse(res, 200, {
        model: "B",
        status: 200,
        headers: { "content-type": "application/json" },
        body: { messages: [{ id: "msg_1", threadId: "t_1" }] },
        auditId: "audit_abc",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await execute(client, {
      connectionId: "conn_123",
      method: "GET",
      url: "https://www.googleapis.com/gmail/v1/users/me/messages",
    });

    assert.ok(!("approvalRequired" in result));
    assert.equal(result.status, 200);
    assert.equal(result.auditId, "audit_abc");
    assert.deepEqual(result.headers, { "content-type": "application/json" });
    assert.deepEqual(result.body, { messages: [{ id: "msg_1", threadId: "t_1" }] });
  });

  it("passes query, headers, and body to the Vault API", async () => {
    const mock = await createMockVault(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      assert.equal(body.method, "POST");
      assert.equal(body.url, "https://www.googleapis.com/gmail/v1/users/me/messages/send");
      assert.deepEqual(body.query, { uploadType: "multipart" });
      assert.deepEqual(body.headers, { "X-Custom": "value" });
      assert.deepEqual(body.body, { raw: "base64data" });

      jsonResponse(res, 200, {
        model: "B",
        status: 200,
        headers: {},
        body: { id: "msg_sent" },
        auditId: "audit_def",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await execute(client, {
      connectionId: "conn_456",
      method: "POST",
      url: "https://www.googleapis.com/gmail/v1/users/me/messages/send",
      query: { uploadType: "multipart" },
      headers: { "X-Custom": "value" },
      body: { raw: "base64data" },
    });

    assert.ok(!("approvalRequired" in result));
    assert.equal(result.status, 200);
    assert.equal(result.auditId, "audit_def");
  });

  it("returns approval output when step-up approval is required", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvalRequired: true,
        approvalRequestId: "apr_789",
        auditId: "audit_ghi",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await execute(client, {
      connectionId: "conn_789",
      method: "POST",
      url: "https://www.googleapis.com/gmail/v1/users/me/messages/send",
      body: { raw: "email_content" },
    });

    assert.ok("approvalRequired" in result);
    assert.equal(result.approvalRequired, true);
    assert.equal(result.approvalRequestId, "apr_789");
    assert.equal(result.auditId, "audit_ghi");
  });

  it("forwards x-ah5-session-key on vault execute requests when session context exists", async () => {
    setCurrentSessionContext({ sessionKey: "agent:main:main" });

    try {
      const mock = await createMockVault(async (req, res) => {
        assert.equal(req.headers["x-ah5-session-key"], "agent:main:main");
        jsonResponse(res, 200, {
          approvalRequired: true,
          approvalRequestId: "apr_session_123",
          auditId: "audit_session_123",
        });
      });
      server = mock.server;
      client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

      const result = await execute(client, {
        connectionId: "conn_789",
        method: "POST",
        url: "https://api.anthropic.com/v1/messages",
        body: { model: "claude-sonnet-4", messages: [{ role: "user", content: "test" }] },
      });

      assert.ok("approvalRequired" in result);
      assert.equal(result.approvalRequestId, "apr_session_123");
    } finally {
      setCurrentSessionContext({ sessionKey: "" });
    }
  });

  it("throws VaultApiError on 403 policy denial", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 403, {
        error: "Policy denies Model B for this agent+connection",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () =>
        execute(client, {
          connectionId: "conn_bad",
          method: "GET",
          url: "https://evil.example.com/data",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("Policy denies"));
        return true;
      },
    );
  });

  it("throws VaultApiError on 429 rate limit exceeded", async () => {
    const mock = await createMockVault(async (_req, res) => {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "120",
      });
      res.end(JSON.stringify({ error: "Rate limit exceeded" }));
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () =>
        execute(client, {
          connectionId: "conn_limited",
          method: "GET",
          url: "https://www.googleapis.com/gmail/v1/users/me/messages",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("Rate limit"));
        return true;
      },
    );
  });
});

describe("approval_request", () => {
  let server: ReturnType<typeof createServer>;
  let client: VaultClient;

  afterEach(() => {
    if (server) server.close();
  });

  it("creates approval request and returns approvalRequestId + auditId", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/vault/execute");
      const body = JSON.parse(await readBody(req));
      assert.equal(body.model, "B");
      assert.equal(body.connectionId, "conn_send");
      assert.equal(body.method, "POST");
      assert.equal(body.url, "https://www.googleapis.com/gmail/v1/users/me/messages/send");

      jsonResponse(res, 200, {
        approvalRequired: true,
        approvalRequestId: "apr_abc",
        auditId: "audit_apr",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await approvalRequest(client, {
      connectionId: "conn_send",
      actionDescription: "Send email via Gmail",
      method: "POST",
      url: "https://www.googleapis.com/gmail/v1/users/me/messages/send",
      body: { raw: "email_base64" },
    });

    assert.equal(result.approvalRequestId, "apr_abc");
    assert.equal(result.auditId, "audit_apr");
  });

  it("throws if request is executed directly (no approval required)", async () => {
    const mock = await createMockVault(async (_req, res) => {
      // The Vault executed directly (no step-up approval configured)
      jsonResponse(res, 200, {
        model: "B",
        status: 200,
        headers: {},
        body: { result: "ok" },
        auditId: "audit_direct",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () =>
        approvalRequest(client, {
          connectionId: "conn_no_approval",
          actionDescription: "Read emails",
          method: "GET",
          url: "https://www.googleapis.com/gmail/v1/users/me/messages",
        }),
      { message: "Expected approval requirement but request was executed directly" },
    );
  });

  it("includes body in the approval request when provided", async () => {
    const mock = await createMockVault(async (req, res) => {
      const body = JSON.parse(await readBody(req));
      assert.deepEqual(body.body, { text: "Hello from agent" });

      jsonResponse(res, 200, {
        approvalRequired: true,
        approvalRequestId: "apr_with_body",
        auditId: "audit_body",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await approvalRequest(client, {
      connectionId: "conn_tg",
      actionDescription: "Send Telegram message",
      method: "POST",
      url: "https://api.telegram.org/bot*/sendMessage",
      body: { text: "Hello from agent" },
    });

    assert.equal(result.approvalRequestId, "apr_with_body");
  });
});

describe("approval_commit", () => {
  let server: ReturnType<typeof createServer>;
  let client: VaultClient;

  afterEach(() => {
    if (server) server.close();
  });

  it("polls until approval is approved and returns result", async () => {
    let pollCount = 0;
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "GET");
      assert.ok(req.url?.startsWith("/v1/approvals"));

      pollCount++;
      if (pollCount < 3) {
        jsonResponse(res, 200, {
          approvals: [
            {
              id: "apr_poll",
              status: "pending",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          ],
        });
      } else {
        jsonResponse(res, 200, {
          approvals: [
            {
              id: "apr_poll",
              status: "approved",
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          ],
        });
      }
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await approvalCommit(
      client,
      { approvalRequestId: "apr_poll" },
      30_000,
      50,
    );

    assert.equal(result.status, 200);
    assert.equal(pollCount, 3);
  });

  it("throws on denial", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvals: [
          {
            id: "apr_denied",
            status: "denied",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => approvalCommit(client, { approvalRequestId: "apr_denied" }, 5000, 50),
      { message: "Approval request was denied by the user" },
    );
  });

  it("throws on expiry", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvals: [
          {
            id: "apr_expired",
            status: "expired",
            expiresAt: new Date(Date.now() - 10_000).toISOString(),
          },
        ],
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => approvalCommit(client, { approvalRequestId: "apr_expired" }, 5000, 50),
      { message: "Approval request expired" },
    );
  });

  it("throws on timeout when approval stays pending", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvals: [
          {
            id: "apr_slow",
            status: "pending",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => approvalCommit(client, { approvalRequestId: "apr_slow" }, 200, 50),
      /timed out/,
    );
  });

  it("throws when approval request is not found", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, { approvals: [] });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => approvalCommit(client, { approvalRequestId: "apr_missing" }, 5000, 50),
      /not found/,
    );
  });

  it("uses custom timeout from input", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvals: [
          {
            id: "apr_custom",
            status: "pending",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        ],
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => approvalCommit(client, { approvalRequestId: "apr_custom", timeoutMs: 150 }, 30_000, 50),
      /timed out after 150ms/,
    );
  });
});
