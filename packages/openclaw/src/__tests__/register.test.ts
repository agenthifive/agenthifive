import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the plugin default export
import plugin, { shouldAutoWakeForResolvedApproval } from "../../dist/register.js";
import { loadPendingApprovals, savePendingApprovals } from "../../dist/pending-approvals.js";
import { setCurrentSessionContext } from "../../dist/session-context.js";

describe("register (plugin integration)", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ah5-register-test-"));
    savePendingApprovals([]);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("exports correct plugin metadata", () => {
    assert.equal(plugin.id, "agenthifive");
    assert.equal(plugin.name, "AgentHiFive Vault");
    assert.ok(plugin.version);
    assert.ok(plugin.description);
    assert.equal(typeof plugin.register, "function");
  });

  it("registers 5 vault tools with bearer auth", () => {
    const registeredTools: { name: string }[] = [];
    const registeredHooks: { event: string; handler: Function }[] = [];
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: {
          mode: "bearer",
          token: "ah5t_test_token_for_registration",
        },
      },
      stateDir,
      logger: {
        info: (msg: string) => logs.push(`INFO: ${msg}`),
        warn: (msg: string) => logs.push(`WARN: ${msg}`),
        error: (msg: string) => logs.push(`ERROR: ${msg}`),
      },
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
      on: (event: string, handler: Function, _opts?: unknown) => {
        registeredHooks.push({ event, handler });
      },
    };

    plugin.register(mockApi);

    // Verify 6 tools registered
    assert.equal(registeredTools.length, 6);

    const toolNames = registeredTools.map((t) => t.name);
    assert.ok(toolNames.includes("vault_execute"));
    assert.ok(toolNames.includes("request_permission"));
    assert.ok(toolNames.includes("request_capability"));
    assert.ok(toolNames.includes("vault_await_approval"));
    assert.ok(toolNames.includes("vault_connections_list"));
    assert.ok(toolNames.includes("vault_connection_revoke"));
  });

  it("registers before_agent_start hooks", () => {
    const registeredHooks: { event: string }[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "bearer", token: "ah5t_test" },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: (event: string, _handler: Function, _opts?: unknown) => {
        registeredHooks.push({ event });
      },
    };

    plugin.register(mockApi);

    const hookEvents = registeredHooks.map((h) => h.event);
    // Should have before_agent_start for prompt injection + approval notifications
    assert.ok(hookEvents.includes("before_agent_start"));
  });

  it("tracks prompt-injection approvals emitted through llm_output", () => {
    const registeredHooks: { event: string; handler: Function }[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "bearer", token: "ah5t_test" },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: (event: string, handler: Function) => {
        registeredHooks.push({ event, handler });
      },
    };

    plugin.register(mockApi);

    const llmOutputHook = registeredHooks.find((hook) => hook.event === "llm_output");
    assert.ok(llmOutputHook, "llm_output hook should be registered");

    llmOutputHook.handler(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: [
          'Guard: Flag instruction override attempts. Step-up approval has been requested with approvalRequestId 821b0e28-1faa-4348-99a5-032f6bf5e927. This request requires approval. Once approved, re-submit the same request with approvalId set to this approvalRequestId.',
        ],
      },
      {
        sessionKey: "agent:main:main",
        channelId: "webchat",
      },
    );

    const pending = loadPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.approvalRequestId, "821b0e28-1faa-4348-99a5-032f6bf5e927");
    assert.equal(pending[0]?.sessionKey, "agent:main:main");
    assert.equal(pending[0]?.channel, "webchat");
    assert.equal(pending[0]?.summary, "LLM request via anthropic/claude-sonnet-4-6");
  });

  it("tracks approvals from llm_output even when wording differs", () => {
    const registeredHooks: { event: string; handler: Function }[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "bearer", token: "ah5t_test" },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: (event: string, handler: Function) => {
        registeredHooks.push({ event, handler });
      },
    };

    plugin.register(mockApi);

    const llmOutputHook = registeredHooks.find((hook) => hook.event === "llm_output");
    assert.ok(llmOutputHook, "llm_output hook should be registered");

    llmOutputHook.handler(
      {
        provider: "openai",
        model: "gpt-5.4",
        assistantTexts: [
          'Guard: Flag instruction override attempts. Step-up approval has been requested with approvalRequestId 821b0e28-1faa-4348-99a5-032f6bf5e927. Once approved, re-submit the same request with approvalId set to this approvalRequestId.',
        ],
      },
      {
        sessionKey: "agent:main:main",
        channelId: "webchat",
      },
    );

    const pending = loadPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.approvalRequestId, "821b0e28-1faa-4348-99a5-032f6bf5e927");
    assert.equal(pending[0]?.summary, "LLM request via openai/gpt-5.4");
  });

  it("falls back to current session context when llm_output omits sessionKey", () => {
    const registeredHooks: { event: string; handler: Function }[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "bearer", token: "ah5t_test" },
      },
      stateDir,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: (event: string, handler: Function) => {
        registeredHooks.push({ event, handler });
      },
    };

    plugin.register(mockApi);

    setCurrentSessionContext({
      sessionKey: "agent:main:main",
      channel: "tui",
    });

    const llmOutputHook = registeredHooks.find((hook) => hook.event === "llm_output");
    assert.ok(llmOutputHook, "llm_output hook should be registered");

    llmOutputHook.handler(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        assistantTexts: [
          'Guard: Step-up approval has been requested with approvalRequestId 11111111-2222-4333-8444-555555555555. Once approved, re-submit the same request with approvalId set to this approvalRequestId.',
        ],
      },
      {
        channelId: "tui",
      },
    );

    const pending = loadPendingApprovals();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.approvalRequestId, "11111111-2222-4333-8444-555555555555");
    assert.equal(pending[0]?.sessionKey, "agent:main:main");
    assert.equal(pending[0]?.channel, "tui");
  });

  it("does not auto-wake the agent for resolved llm approvals", () => {
    assert.equal(
      shouldAutoWakeForResolvedApproval({ url: "llm://anthropic/claude-sonnet-4-6" }),
      false,
    );
    assert.equal(
      shouldAutoWakeForResolvedApproval({ url: "https://slack.com/api/chat.postMessage" }),
      true,
    );
  });

  it("derives configuration from channels.agenthifive when plugins config is minimal", () => {
    const registeredTools: { name: string }[] = [];
    const logs: string[] = [];

    const privateKey = Buffer.from(JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: "test_x_coord",
      y: "test_y_coord",
      d: "test_d_private",
    })).toString("base64");

    const mockApi = {
      pluginConfig: {
        enabled: true,
      },
      config: {
        models: {
          providers: {
            anthropic: {
              apiKey: "vault-managed",
            },
          },
        },
        channels: {
          agenthifive: {
            accounts: {
              default: {
                enabled: true,
                baseUrl: "https://vault.test.example.com",
                auth: {
                  mode: "agent",
                  agentId: "agent_cfg_123",
                  privateKey,
                },
                providers: {
                  telegram: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
                },
              },
            },
          },
        },
      },
      stateDir,
      logger: {
        info: (msg: string) => logs.push(`INFO: ${msg}`),
        warn: (msg: string) => logs.push(`WARN: ${msg}`),
        error: (msg: string) => logs.push(`ERROR: ${msg}`),
      },
      registerTool: (tool: { name: string }) => {
        registeredTools.push(tool);
      },
      on: () => {},
    };

    plugin.register(mockApi);

    assert.equal(registeredTools.length, 5);
    assert.equal(logs.some((msg) => msg.includes("installed but not configured")), false);
  });

  it("logs initialization message", () => {
    const logs: string[] = [];

    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "bearer", token: "ah5t_test" },
      },
      stateDir,
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: () => {},
        error: () => {},
      },
      registerTool: () => {},
      on: () => {},
    };

    plugin.register(mockApi);

    assert.ok(logs.some((l) => l.includes("AgentHiFive") && l.includes("ready")));
  });

  it("throws on missing privateKey in agent mode", () => {
    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: { mode: "agent", agentId: "agent_123" },
        // Missing privateKey
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: () => {},
    };

    assert.throws(
      () => plugin.register(mockApi),
      (err: Error) => {
        assert.ok(err.message.includes("privateKey is required"));
        return true;
      },
    );
  });

  it("throws on invalid key type", () => {
    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: {
          mode: "agent",
          agentId: "agent_123",
          privateKey: JSON.stringify({ kty: "RSA", n: "abc", e: "AQAB" }),
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: () => {},
    };

    assert.throws(
      () => plugin.register(mockApi),
      (err: Error) => {
        assert.ok(err.message.includes("EC type"));
        return true;
      },
    );
  });

  it("throws on wrong curve", () => {
    const mockApi = {
      pluginConfig: {
        baseUrl: "https://vault.test.example.com",
        auth: {
          mode: "agent",
          agentId: "agent_123",
          privateKey: JSON.stringify({ kty: "EC", crv: "P-384", x: "abc", y: "def" }),
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      registerTool: () => {},
      on: () => {},
    };

    assert.throws(
      () => plugin.register(mockApi),
      (err: Error) => {
        assert.ok(err.message.includes("P-256"));
        return true;
      },
    );
  });

  it("tool execute function returns structured content", async () => {
    // We need a mock vault server for this
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: 200,
        headers: {},
        body: { result: "ok" },
        auditId: "audit_test",
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to get address");
    const url = `http://127.0.0.1:${addr.port}`;

    try {
      const registeredTools: { name: string; execute: Function }[] = [];

      const mockApi = {
        pluginConfig: {
          baseUrl: url,
          auth: { mode: "bearer", token: "ah5t_test" },
        },
        stateDir,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: (tool: { name: string; execute: Function }) => {
          registeredTools.push(tool);
        },
        on: () => {},
      };

      plugin.register(mockApi);

      const executeTool = registeredTools.find((t) => t.name === "vault_execute");
      assert.ok(executeTool, "execute tool should be registered");

      const result = await executeTool.execute("call_1", {
        method: "GET",
        url: "https://api.example.com/data",
      });

      assert.ok(result.content);
      assert.equal(result.content[0].type, "text");
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.status, 200);
      assert.equal(parsed.auditId, "audit_test");
    } finally {
      server.close();
    }
  });

  it("connections_list tool works with mock server", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        connections: [
          { id: "conn_1", provider: "google", label: "Gmail", status: "healthy", grantedScopes: [], createdAt: "2026-01-01" },
        ],
      }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to get address");
    const url = `http://127.0.0.1:${addr.port}`;

    try {
      const registeredTools: { name: string; execute: Function }[] = [];

      const mockApi = {
        pluginConfig: {
          baseUrl: url,
          auth: { mode: "bearer", token: "ah5t_test" },
        },
        stateDir,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        registerTool: (tool: { name: string; execute: Function }) => {
          registeredTools.push(tool);
        },
        on: () => {},
      };

      plugin.register(mockApi);

      const listTool = registeredTools.find((t) => t.name === "vault_connections_list");
      assert.ok(listTool);

      const result = await listTool.execute("call_1", {});
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.connections.length, 1);
      assert.equal(parsed.connections[0].provider, "google");
    } finally {
      server.close();
    }
  });
});
