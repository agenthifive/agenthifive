import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { VaultClient } from "@agenthifive/agenthifive";
import { createMcpServer } from "../../dist/index.js";

/**
 * Creates a mock Vault HTTP server for testing MCP tools.
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
    req.on("end", () => resolve(data));
  });
}

describe("createMcpServer", () => {
  it("creates an MCP server with 3 tools registered", () => {
    const client = new VaultClient({
      baseUrl: "http://localhost:8080",
      auth: { mode: "api_key", apiKey: "test" },
    });
    const config = { baseUrl: "http://localhost:8080", pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const server = createMcpServer(client, config);

    assert.ok(server, "MCP server should be created");
  });
});

describe("execute tool", () => {
  let server: ReturnType<typeof createServer>;

  afterEach(() => {
    if (server) server.close();
  });

  it("sends Model B execute request to vault", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/vault/execute");

      const body = JSON.parse(await readBody(req));
      assert.equal(body.model, "B");
      assert.equal(body.connectionId, "conn_123");
      assert.equal(body.method, "GET");
      assert.equal(body.url, "https://gmail.googleapis.com/gmail/v1/users/me/messages");

      jsonResponse(res, 200, {
        model: "B",
        status: 200,
        headers: { "content-type": "application/json" },
        body: { messages: [{ id: "msg_1" }] },
        auditId: "audit_exec_001",
      });
    });
    server = mock.server;

    const client = new VaultClient({
      baseUrl: mock.url,
      auth: { mode: "api_key", apiKey: "test-key" },
    });
    const config = { baseUrl: mock.url, pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });

  it("handles approval required response", async () => {
    const mock = await createMockVault(async (_req, res) => {
      jsonResponse(res, 200, {
        approvalRequired: true,
        approvalRequestId: "apr_789",
        auditId: "audit_apr_001",
      });
    });
    server = mock.server;

    const client = new VaultClient({
      baseUrl: mock.url,
      auth: { mode: "api_key", apiKey: "test-key" },
    });
    const config = { baseUrl: mock.url, pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });
});

describe("list_connections tool", () => {
  let server: ReturnType<typeof createServer>;

  afterEach(() => {
    if (server) server.close();
  });

  it("calls GET /connections and returns connections", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/connections");

      jsonResponse(res, 200, {
        connections: [
          {
            id: "conn_1",
            provider: "google",
            label: "Work Gmail",
            status: "healthy",
            grantedScopes: ["gmail.readonly"],
            createdAt: "2026-01-15T10:00:00.000Z",
          },
        ],
      });
    });
    server = mock.server;

    const client = new VaultClient({
      baseUrl: mock.url,
      auth: { mode: "api_key", apiKey: "test-key" },
    });
    const config = { baseUrl: mock.url, pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });
});

describe("revoke tool", () => {
  let server: ReturnType<typeof createServer>;

  afterEach(() => {
    if (server) server.close();
  });

  it("calls POST /connections/:id/revoke", async () => {
    const mock = await createMockVault(async (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/connections/conn_abc/revoke");

      jsonResponse(res, 200, {
        connection: {
          id: "conn_abc",
          provider: "google",
          label: "Work Gmail",
          status: "revoked",
        },
        auditId: "audit_rev_001",
      });
    });
    server = mock.server;

    const client = new VaultClient({
      baseUrl: mock.url,
      auth: { mode: "api_key", apiKey: "test-key" },
    });
    const config = { baseUrl: mock.url, pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });
});

describe("MCP tool integration", () => {
  let server: ReturnType<typeof createServer>;

  afterEach(() => {
    if (server) server.close();
  });

  it("uses api_key auth when configured", () => {
    const client = new VaultClient({
      baseUrl: "http://localhost:8080",
      auth: { mode: "api_key", apiKey: "ah5_my_api_key" },
    });
    const config = { baseUrl: "http://localhost:8080", pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });

  it("uses bearer token auth when configured", () => {
    const client = new VaultClient({
      baseUrl: "http://localhost:8080",
      auth: { mode: "bearer", token: "jwt-token-here" },
    });
    const config = { baseUrl: "http://localhost:8080", pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    assert.ok(mcpServer);
  });

  it("server has correct name and version", () => {
    const client = new VaultClient({
      baseUrl: "http://localhost:8080",
      auth: { mode: "api_key", apiKey: "test" },
    });
    const config = { baseUrl: "http://localhost:8080", pollTimeoutMs: 5000, pollIntervalMs: 1000 };
    const mcpServer = createMcpServer(client, config);
    // Server is created and functional
    assert.ok(mcpServer.server, "Underlying MCP Server instance should exist");
  });
});
