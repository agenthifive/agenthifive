import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { AgentHiFiveClient } from "../../dist/client.js";
import { AgentHiFiveError } from "../../dist/errors.js";

// Minimal mock server using a fetch interceptor
let mockHandler: (url: string, init: RequestInit) => Response;

const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  mockHandler = handler;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(mockHandler(url, init ?? {}));
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AgentHiFiveClient", () => {
  let client: AgentHiFiveClient;

  beforeEach(() => {
    client = new AgentHiFiveClient({
      baseUrl: "https://api.test.com/",
      bearerToken: "ah5t_test_token",
    });
  });

  afterEach(() => {
    restoreFetch();
  });

  it("strips trailing slash from baseUrl", async () => {
    mockFetch((url) => {
      assert.ok(url.startsWith("https://api.test.com/connections"));
      return jsonResponse({ connections: [] });
    });
    await client.listConnections();
  });

  it("sends Authorization header with Bearer token", async () => {
    mockFetch((_url, init) => {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer ah5t_test_token");
      return jsonResponse({ connections: [] });
    });
    await client.listConnections();
  });

  it("requires either bearerToken or privateKey + agentId", () => {
    assert.throws(() => {
      new AgentHiFiveClient({ baseUrl: "https://api.test.com" });
    }, /requires either/);
  });

  describe("listConnections", () => {
    it("returns connections array", async () => {
      const mockConns = [
        { id: "c1", provider: "google", label: "Gmail", status: "healthy", grantedScopes: ["gmail.readonly"], createdAt: "2025-01-01T00:00:00Z" },
      ];
      mockFetch(() => jsonResponse({ connections: mockConns }));
      const result = await client.listConnections();
      assert.equal(result.length, 1);
      assert.equal(result[0]?.provider, "google");
    });
  });

  describe("revokeConnection", () => {
    it("calls POST /connections/:id/revoke", async () => {
      mockFetch((url, init) => {
        assert.ok(url.endsWith("/connections/conn-123/revoke"));
        assert.equal(init.method, "POST");
        return jsonResponse({ revoked: true, auditId: "audit-1" });
      });
      const result = await client.revokeConnection("conn-123");
      assert.equal(result.revoked, true);
      assert.equal(result.auditId, "audit-1");
    });

    it("URL-encodes connection ID", async () => {
      mockFetch((url) => {
        assert.ok(url.includes("/connections/conn%2F123/revoke"));
        return jsonResponse({ revoked: true, auditId: "a" });
      });
      await client.revokeConnection("conn/123");
    });
  });

  describe("execute", () => {
    it("sends Model A request", async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(init.body as string);
        assert.equal(body.model, "A");
        assert.equal(body.connectionId, "c1");
        return jsonResponse({ model: "A", accessToken: "tok", tokenType: "Bearer", expiresIn: 3600, auditId: "a1" });
      });
      const result = await client.execute({ model: "A", connectionId: "c1" });
      assert.ok("model" in result && result.model === "A");
    });

    it("sends Model B request", async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(init.body as string);
        assert.equal(body.model, "B");
        assert.equal(body.method, "GET");
        assert.equal(body.url, "https://api.example.com/data");
        return jsonResponse({ model: "B", status: 200, headers: {}, body: { ok: true }, auditId: "a2" });
      });
      const result = await client.execute({
        model: "B",
        connectionId: "c1",
        method: "GET",
        url: "https://api.example.com/data",
      });
      assert.ok("model" in result && result.model === "B");
    });

    it("returns approval requirement", async () => {
      mockFetch(() => jsonResponse({ approvalRequired: true, approvalRequestId: "ar1", auditId: "a3" }));
      const result = await client.execute({
        model: "B",
        connectionId: "c1",
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      });
      assert.ok("approvalRequired" in result);
    });
  });

  describe("listApprovals", () => {
    it("returns approvals array", async () => {
      mockFetch(() =>
        jsonResponse({
          approvals: [{ id: "ap1", status: "pending", agentName: "Bot", connectionLabel: "Gmail" }],
        }),
      );
      const result = await client.listApprovals();
      assert.equal(result.length, 1);
      assert.equal(result[0]?.id, "ap1");
    });
  });

  describe("approveAction", () => {
    it("calls POST /approvals/:id/approve", async () => {
      mockFetch((url, init) => {
        assert.ok(url.endsWith("/approvals/ap1/approve"));
        assert.equal(init.method, "POST");
        return jsonResponse({ model: "B", status: 200, headers: {}, body: {}, auditId: "a4" });
      });
      const result = await client.approveAction("ap1");
      assert.equal(result.auditId, "a4");
    });
  });

  describe("denyAction", () => {
    it("calls POST /approvals/:id/deny", async () => {
      mockFetch((url) => {
        assert.ok(url.endsWith("/approvals/ap1/deny"));
        return jsonResponse({ denied: true, approvalRequestId: "ap1", auditId: "a5" });
      });
      const result = await client.denyAction("ap1");
      assert.equal(result.denied, true);
    });
  });

  describe("connect", () => {
    it("sends POST /connections/start with provider", async () => {
      mockFetch((_url, init) => {
        const body = JSON.parse(init.body as string);
        assert.equal(body.provider, "google");
        assert.equal(body.label, "My Gmail");
        return jsonResponse({
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?...",
          pendingConnectionId: "pc1",
        });
      });
      const result = await client.connect("google", { label: "My Gmail" });
      assert.equal(result.pendingConnectionId, "pc1");
      assert.equal(result.authorizationUrl, "https://accounts.google.com/o/oauth2/v2/auth?...");
    });
  });

  describe("listAuditEvents", () => {
    it("passes query parameters", async () => {
      mockFetch((url) => {
        assert.ok(url.includes("agentId=ag1"));
        assert.ok(url.includes("action=execution_completed"));
        assert.ok(url.includes("limit=10"));
        return jsonResponse({ events: [], nextCursor: null });
      });
      await client.listAuditEvents({ agentId: "ag1", action: "execution_completed", limit: 10 });
    });

    it("calls /audit without params when no options", async () => {
      mockFetch((url) => {
        assert.ok(url.endsWith("/audit"));
        return jsonResponse({ events: [], nextCursor: null });
      });
      await client.listAuditEvents();
    });
  });

  describe("error handling", () => {
    it("throws AgentHiFiveError on API error", async () => {
      mockFetch(() =>
        new Response(JSON.stringify({ error: "Policy denied" }), { status: 403 }),
      );
      await assert.rejects(
        () => client.listConnections(),
        (err: unknown) => {
          assert.ok(err instanceof AgentHiFiveError);
          assert.equal(err.statusCode, 403);
          assert.equal(err.message, "Policy denied");
          return true;
        },
      );
    });

    it("includes auditId from error response", async () => {
      mockFetch(() =>
        new Response(JSON.stringify({ error: "Rate limit", auditId: "aud-1", retryAfter: 60 }), { status: 429 }),
      );
      await assert.rejects(
        () => client.execute({ model: "A", connectionId: "c1" }),
        (err: unknown) => {
          assert.ok(err instanceof AgentHiFiveError);
          assert.equal(err.auditId, "aud-1");
          assert.equal(err.retryAfter, 60);
          return true;
        },
      );
    });

    it("reads Retry-After header as fallback", async () => {
      mockFetch(() =>
        new Response(JSON.stringify({ error: "Too many requests" }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      );
      await assert.rejects(
        () => client.execute({ model: "A", connectionId: "c1" }),
        (err: unknown) => {
          assert.ok(err instanceof AgentHiFiveError);
          assert.equal(err.retryAfter, 30);
          return true;
        },
      );
    });
  });
});
