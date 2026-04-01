import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VaultClient, VaultApiError } from "../../dist/client.js";
import { connectionsList, connectionRevoke } from "../../dist/tools.js";

/**
 * Creates a mock Vault HTTP server for testing connections management tools.
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

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

describe("connections_list", () => {
  let server: ReturnType<typeof createServer>;
  let client: VaultClient;

  afterEach(() => {
    if (server) server.close();
  });

  it("calls GET /v1/connections and returns array of connections", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/v1/connections");

      // Verify Authorization header is sent
      assert.ok(req.headers.authorization?.startsWith("Bearer "));

      jsonResponse(res, 200, {
        connections: [
          {
            id: "conn_1",
            provider: "google",
            label: "My Google Account",
            status: "healthy",
            grantedScopes: ["gmail.readonly", "calendar.readonly"],
            createdAt: "2026-01-15T10:00:00.000Z",
          },
          {
            id: "conn_2",
            provider: "telegram",
            label: "Support Bot",
            status: "healthy",
            grantedScopes: [],
            createdAt: "2026-01-20T14:30:00.000Z",
          },
          {
            id: "conn_3",
            provider: "microsoft",
            label: "Work Teams",
            status: "needs_reauth",
            grantedScopes: ["Chat.Read", "User.Read"],
            createdAt: "2026-02-01T09:00:00.000Z",
          },
        ],
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await connectionsList(client);

    assert.equal(result.connections.length, 3);
    assert.equal(result.connections[0]!.id, "conn_1");
    assert.equal(result.connections[0]!.provider, "google");
    assert.equal(result.connections[0]!.label, "My Google Account");
    assert.equal(result.connections[0]!.status, "healthy");
    assert.deepEqual(result.connections[0]!.grantedScopes, ["gmail.readonly", "calendar.readonly"]);
    assert.equal(result.connections[0]!.createdAt, "2026-01-15T10:00:00.000Z");

    assert.equal(result.connections[1]!.id, "conn_2");
    assert.equal(result.connections[1]!.provider, "telegram");

    assert.equal(result.connections[2]!.id, "conn_3");
    assert.equal(result.connections[2]!.status, "needs_reauth");
  });

  it("returns empty array when no connections exist", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, { connections: [] });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "ah5_testkey" } });

    const result = await connectionsList(client);

    assert.equal(result.connections.length, 0);
    assert.deepEqual(result.connections, []);
  });

  it("sends bearer token authentication header", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer ah5_my_api_key");
      jsonResponse(res, 200, { connections: [] });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "ah5_my_api_key" } });

    await connectionsList(client);
  });

  it("throws VaultApiError on server error", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 500, { error: "Internal server error" });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => connectionsList(client),
      (err: VaultApiError) => {
        assert.equal(err.statusCode, 500);
        return true;
      },
    );
  });

  it("throws VaultApiError on 401 unauthorized", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 401, { error: "Invalid or expired token" });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "expired-jwt" } });

    await assert.rejects(
      () => connectionsList(client),
      (err: VaultApiError) => {
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
  });
});

describe("connection_revoke", () => {
  let server: ReturnType<typeof createServer>;
  let client: VaultClient;

  afterEach(() => {
    if (server) server.close();
  });

  it("calls POST /v1/connections/:id/revoke and returns confirmation with auditId", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/connections/conn_abc/revoke");
      assert.ok(req.headers.authorization?.startsWith("Bearer "));

      jsonResponse(res, 200, {
        connection: {
          id: "conn_abc",
          provider: "google",
          label: "My Google Account",
          status: "revoked",
        },
        auditId: "audit_revoke_123",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await connectionRevoke(client, { connectionId: "conn_abc" });

    assert.equal(result.revoked, true);
    assert.equal(result.connectionId, "conn_abc");
    assert.equal(result.auditId, "audit_revoke_123");
  });

  it("URL-encodes the connection ID", async () => {
    const mock = await createMockVault(async (req, res) => {
      // Connection IDs with special characters should be encoded
      assert.equal(req.url, "/v1/connections/conn%20with%20spaces/revoke");
      jsonResponse(res, 200, {
        connection: { id: "conn with spaces", provider: "google", label: "Test", status: "revoked" },
        auditId: "audit_456",
      });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    const result = await connectionRevoke(client, { connectionId: "conn with spaces" });

    assert.equal(result.revoked, true);
    assert.equal(result.connectionId, "conn with spaces");
  });

  it("throws VaultApiError on 404 not found", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 404, { error: "Connection not found" });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => connectionRevoke(client, { connectionId: "nonexistent" }),
      (err: VaultApiError) => {
        assert.equal(err.statusCode, 404);
        return true;
      },
    );
  });

  it("throws VaultApiError on 409 already revoked", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 409, { error: "Connection already revoked" });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "test-jwt" } });

    await assert.rejects(
      () => connectionRevoke(client, { connectionId: "conn_already_revoked" }),
      (err: VaultApiError) => {
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  });

  it("throws VaultApiError on 401 unauthorized", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 401, { error: "Invalid token" });
    });
    server = mock.server;
    client = new VaultClient({ baseUrl: mock.url, auth: { mode: "bearer", token: "bad-token" } });

    await assert.rejects(
      () => connectionRevoke(client, { connectionId: "conn_xyz" }),
      (err: VaultApiError) => {
        assert.equal(err.statusCode, 401);
        return true;
      },
    );
  });
});
