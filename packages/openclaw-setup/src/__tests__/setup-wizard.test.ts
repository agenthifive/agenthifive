import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import {
  buildProviderModelTree,
  buildConfigOutput,
  parseOpenClawModelList,
  removeAgentHiFiveChannelConfig,
  parseSetupArgs,
} from "../../dist/setup-wizard.js";
import {
  resolveOpenClawConfigPath,
  readExistingConfig,
  mergePluginConfig,
  defaultConfigPath,
} from "../../dist/config-discovery.js";

describe("setup-wizard", () => {
  describe("parseSetupArgs", () => {
    it("parses --base-url flag", () => {
      const opts = parseSetupArgs(["--base-url", "https://vault.example.com"]);
      assert.equal(opts.baseUrl, "https://vault.example.com");
    });

    it("parses --bootstrap-secret flag", () => {
      const opts = parseSetupArgs(["--bootstrap-secret", "ah5b_test_secret"]);
      assert.equal(opts.bootstrapSecret, "ah5b_test_secret");
    });

    it("parses --non-interactive flag", () => {
      const opts = parseSetupArgs(["--non-interactive"]);
      assert.equal(opts.nonInteractive, true);
    });

    it("returns empty opts for no args", () => {
      const opts = parseSetupArgs([]);
      assert.equal(opts.baseUrl, undefined);
      assert.equal(opts.bootstrapSecret, undefined);
      assert.equal(opts.nonInteractive, undefined);
    });

    it("ignores unknown flags", () => {
      const opts = parseSetupArgs(["--unknown", "value", "--base-url", "https://example.com"]);
      assert.equal(opts.baseUrl, "https://example.com");
    });

    it("handles all flags together", () => {
      const opts = parseSetupArgs([
        "--base-url", "https://vault.example.com",
        "--bootstrap-secret", "ah5b_my_secret",
        "--non-interactive",
      ]);
      assert.equal(opts.baseUrl, "https://vault.example.com");
      assert.equal(opts.bootstrapSecret, "ah5b_my_secret");
      assert.equal(opts.nonInteractive, true);
    });

    it("parses --config-path flag", () => {
      const opts = parseSetupArgs(["--config-path", "/custom/openclaw.json"]);
      assert.equal(opts.configPath, "/custom/openclaw.json");
    });

    it("parses --openclaw-dir flag", () => {
      const opts = parseSetupArgs(["--openclaw-dir", "/usr/lib/node_modules/openclaw"]);
      assert.equal(opts.openclawDir, "/usr/lib/node_modules/openclaw");
    });

    it("parses --skip-onboard and --skip-plugin-install flags", () => {
      const opts = parseSetupArgs(["--skip-onboard", "--skip-plugin-install"]);
      assert.equal(opts.skipOnboard, true);
      assert.equal(opts.skipPluginInstall, true);
    });

    it("parses --default-model flag", () => {
      const opts = parseSetupArgs(["--default-model", "openai/gpt-4.1"]);
      assert.equal(opts.defaultModel, "openai/gpt-4.1");
    });

    it("parses --mode flag", () => {
      assert.equal(parseSetupArgs(["--mode", "setup"]).mode, "setup");
      assert.equal(parseSetupArgs(["--mode", "change-model"]).mode, "change-model");
      assert.equal(parseSetupArgs(["--mode", "reconnect"]).mode, "reconnect");
      assert.equal(parseSetupArgs(["--mode", "sync"]).mode, "sync");
      assert.equal(parseSetupArgs(["--mode", "remove"]).mode, "remove");
    });

    it("ignores invalid --mode values", () => {
      const opts = parseSetupArgs(["--mode", "invalid"]);
      assert.equal(opts.mode, undefined);
    });
  });

  describe("buildConfigOutput", () => {
    const testPrivateKey: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      x: "test_x_coord",
      y: "test_y_coord",
      d: "test_d_private",
    };

    it("generates valid plugin config structure", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_test_123",
        privateKey: testPrivateKey,
        connections: { telegram: "conn_1", slack: "conn_2" },
        connectedProviders: ["telegram", "slack"],
        proxiedProviders: [],
      }) as Record<string, unknown>;

      // Top-level has plugins key
      assert.ok(config.plugins);
      const plugins = config.plugins as Record<string, unknown>;
      assert.equal(plugins.enabled, true);
      assert.deepEqual(plugins.allow, ["agenthifive"]);

      // Plugin entries
      const entries = (plugins as { entries: Record<string, unknown> }).entries;
      assert.ok(entries.agenthifive);
      const ah5 = entries.agenthifive as Record<string, unknown>;
      assert.deepEqual(ah5, { enabled: true });
    });

    it("sets models.providers baseUrl to vault LLM proxy for proxied providers", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: { anthropic: "vault-managed" },
        connectedProviders: ["anthropic"],
        proxiedProviders: ["anthropic"],
      }) as Record<string, unknown>;

      const models = config.models as { providers: Record<string, { baseUrl: string; apiKey: string; models: unknown[] }> };
      assert.ok(models.providers.anthropic);
      assert.equal(models.providers.anthropic.baseUrl, "https://vault.example.com/v1/vault/llm/anthropic");
      assert.equal(models.providers.anthropic.apiKey, "vault-managed");
      assert.ok(Array.isArray(models.providers.anthropic.models), "models array required by OpenClaw");
      assert.ok(models.providers.anthropic.models.length > 0);
    });

    it("uses provided provider model catalog when available", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: { anthropic: "vault-managed" },
        connectedProviders: ["anthropic"],
        proxiedProviders: ["anthropic"],
        providerModels: {
          anthropic: [
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"] },
            { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", input: ["text"] },
          ],
        },
      }) as Record<string, unknown>;

      const models = config.models as { providers: Record<string, { models: Array<{ id: string }> }> };
      assert.deepEqual(
        models.providers.anthropic.models.map((entry) => entry.id),
        ["claude-sonnet-4-6", "claude-3-7-sonnet"],
      );
    });

    it("adds a google provider alias for gemini vault proxying", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: { gemini: "vault-managed" },
        connectedProviders: ["gemini"],
        proxiedProviders: ["gemini"],
        providerModels: {
          gemini: [
            { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", input: ["text"] },
          ],
        },
      }) as Record<string, unknown>;

      const models = config.models as {
        providers: Record<string, { baseUrl: string; apiKey: string; models: Array<{ id: string }> }>;
      };
      assert.ok(models.providers.gemini);
      assert.ok(models.providers.google);
      assert.equal(models.providers.gemini.baseUrl, "https://vault.example.com/v1/vault/llm/gemini");
      assert.equal(models.providers.google.baseUrl, "https://vault.example.com/v1/vault/llm/gemini");
      assert.equal(models.providers.google.apiKey, "vault-managed");
      assert.deepEqual(
        models.providers.google.models.map((entry) => entry.id),
        ["gemini-3.1-flash-lite-preview"],
      );
    });

    it("does not set models.providers when no proxied providers", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: {},
        connectedProviders: [],
        proxiedProviders: [],
      }) as Record<string, unknown>;

      const models = config.models as { providers: Record<string, unknown> };
      assert.deepEqual(models.providers, {});
    });

    it("sets agents.defaults.model when defaultModel provided", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: { anthropic: "vault-managed" },
        connectedProviders: ["anthropic"],
        proxiedProviders: ["anthropic"],
        defaultModel: "anthropic/claude-opus-4-6",
      }) as Record<string, unknown>;

      const agents = config.agents as { defaults: { model: string } };
      assert.equal(agents.defaults.model, "anthropic/claude-opus-4-6");
    });

    it("omits agents block when no defaultModel", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_abc",
        privateKey: testPrivateKey,
        connections: {},
        connectedProviders: [],
        proxiedProviders: [],
      }) as Record<string, unknown>;

      assert.equal(config.agents, undefined);
    });

    it("output is valid JSON (round-trips cleanly)", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_123",
        privateKey: testPrivateKey,
        connections: { telegram: "conn_1" },
        connectedProviders: ["telegram"],
        proxiedProviders: ["openai"],
      });

      const json = JSON.stringify(config, null, 2);
      const parsed = JSON.parse(json);
      assert.deepEqual(parsed, config);
    });

    it("writes vault-managed channel config under channels.agenthifive.accounts.default", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_channels_123",
        privateKey: testPrivateKey,
        connections: { telegram: "vault-managed", slack: "vault-managed" },
        connectedProviders: ["telegram", "slack"],
        proxiedProviders: [],
        channels: {
          telegram: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
          slack: { enabled: true },
        },
      }) as Record<string, unknown>;

      const channels = config.channels as {
        agenthifive: {
          accounts: {
            default: {
              enabled: boolean;
              baseUrl: string;
              auth: { mode: string; agentId: string; privateKey: string };
              providers: Record<string, unknown>;
            };
          };
        };
      };

      assert.equal(channels.agenthifive.accounts.default.enabled, true);
      assert.equal(channels.agenthifive.accounts.default.baseUrl, "https://vault.example.com");
      assert.equal(channels.agenthifive.accounts.default.auth.mode, "agent");
      assert.equal(channels.agenthifive.accounts.default.auth.agentId, "agent_channels_123");
      assert.deepEqual(channels.agenthifive.accounts.default.providers.telegram, {
        enabled: true,
        dmPolicy: "balanced",
        allowFrom: [],
      });
      assert.deepEqual(channels.agenthifive.accounts.default.providers.slack, {
        enabled: true,
      });
    });


    it("keeps plugin entry minimal because runtime derives config from channels.agenthifive", () => {
      const config = buildConfigOutput({
        baseUrl: "https://vault.example.com",
        agentId: "agent_channels_123",
        privateKey: testPrivateKey,
        connections: { telegram: "vault-managed" },
        connectedProviders: ["telegram"],
        proxiedProviders: ["openai"],
        channels: {
          telegram: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
        },
      }) as Record<string, unknown>;

      const plugins = config.plugins as {
        entries: {
          agenthifive: Record<string, unknown>;
        };
      };

      assert.deepEqual(plugins.entries.agenthifive, { enabled: true });
    });
  });

  describe("removeAgentHiFiveChannelConfig", () => {
    it("removes the AgentHiFive channel block and preserves others", () => {
      const cleaned = removeAgentHiFiveChannelConfig({
        channels: {
          agenthifive: {
            accounts: {
              default: {
                enabled: true,
              },
            },
          },
          discord: {
            enabled: true,
          },
        },
        plugins: {
          entries: {
            agenthifive: { enabled: true },
          },
        },
      });

      const channels = cleaned.channels as Record<string, unknown>;
      assert.equal("agenthifive" in channels, false);
      assert.equal("discord" in channels, true);
      const plugins = cleaned.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, unknown>;
      assert.equal("agenthifive" in entries, true);
    });

    it("removes the channels block entirely when AgentHiFive was the only channel", () => {
      const cleaned = removeAgentHiFiveChannelConfig({
        channels: {
          agenthifive: {
            accounts: {
              default: {
                enabled: true,
              },
            },
          },
        },
      });

      assert.equal(cleaned.channels, undefined);
    });
  });

  describe("parseOpenClawModelList", () => {
    it("normalizes OpenClaw models list JSON rows into setup models", () => {
      const models = parseOpenClawModelList("anthropic", JSON.stringify({
        count: 2,
        models: [
          {
            key: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            input: "text+image",
            tags: ["configured"],
          },
          {
            key: "anthropic/claude-3-7-sonnet",
            name: "Claude 3.7 Sonnet",
            input: "text",
            tags: [],
          },
        ],
      }));

      assert.deepEqual(models, [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"] },
        { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet", input: ["text"] },
      ]);
    });

    it("ignores rows outside the requested provider and missing entries", () => {
      const models = parseOpenClawModelList("openai", JSON.stringify({
        count: 3,
        models: [
          { key: "openai/gpt-4.1", name: "GPT-4.1", input: "text+image" },
          { key: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: "text+image" },
          { key: "openai/missing-model", name: "Missing Model", input: "text", missing: true },
        ],
      }));

      assert.deepEqual(models, [
        { id: "gpt-4.1", name: "GPT-4.1", input: ["text", "image"] },
      ]);
    });
  });

  describe("buildProviderModelTree", () => {
    it("groups models by provider and preserves provider order", () => {
      const tree = buildProviderModelTree(
        ["anthropic", "openai", "openrouter"],
        {
          anthropic: [
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"] },
          ],
          openai: [
            { id: "gpt-4.1", name: "GPT-4.1", input: ["text", "image"] },
            { id: "o3", name: "o3", input: ["text", "image"] },
          ],
          openrouter: [],
        },
      );

      assert.deepEqual(tree, [
        {
          provider: "anthropic",
          models: [
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text", "image"] },
          ],
        },
        {
          provider: "openai",
          models: [
            { id: "gpt-4.1", name: "GPT-4.1", input: ["text", "image"] },
            { id: "o3", name: "o3", input: ["text", "image"] },
          ],
        },
      ]);
    });
  });
});

describe("config-discovery", () => {
  describe("resolveOpenClawConfigPath", () => {
    it("returns null when no config exists (clean env)", () => {
      // Use env overrides to avoid finding real config files
      const result = resolveOpenClawConfigPath({
        OPENCLAW_STATE_DIR: "/tmp/nonexistent-openclaw-dir-" + Date.now(),
      });
      assert.equal(result, null);
    });

    it("respects OPENCLAW_CONFIG_PATH env var", () => {
      // Point to a file that doesn't exist
      const result = resolveOpenClawConfigPath({
        OPENCLAW_CONFIG_PATH: "/tmp/nonexistent-config-" + Date.now() + ".json",
      });
      assert.equal(result, null);
    });

    it("returns path when OPENCLAW_CONFIG_PATH points to existing file", () => {
      const tmpDir = `/tmp/test-openclaw-config-${Date.now()}`;
      const configFile = `${tmpDir}/openclaw.json`;
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(configFile, "{}");
      try {
        const result = resolveOpenClawConfigPath({
          OPENCLAW_CONFIG_PATH: configFile,
        });
        assert.equal(result, configFile);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("defaultConfigPath", () => {
    it("returns a path ending with .openclaw/openclaw.json", () => {
      const p = defaultConfigPath();
      assert.ok(p.endsWith(".openclaw/openclaw.json") || p.endsWith(".openclaw\\openclaw.json"));
    });
  });

  describe("readExistingConfig", () => {
    it("returns empty object for non-existent file", () => {
      const result = readExistingConfig("/tmp/nonexistent-" + Date.now() + ".json");
      assert.deepEqual(result, {});
    });

    it("parses valid JSON", () => {
      const tmpFile = `/tmp/test-config-${Date.now()}.json`;
      writeFileSync(tmpFile, '{"key": "value"}');
      try {
        const result = readExistingConfig(tmpFile);
        assert.deepEqual(result, { key: "value" });
      } finally {
        rmSync(tmpFile, { force: true });
      }
    });

    it("strips single-line comments (JSON5 compat)", () => {
      const tmpFile = `/tmp/test-config-comments-${Date.now()}.json`;
      writeFileSync(tmpFile, '{\n  // comment\n  "key": "value"\n}');
      try {
        const result = readExistingConfig(tmpFile);
        assert.deepEqual(result, { key: "value" });
      } finally {
        rmSync(tmpFile, { force: true });
      }
    });
  });

  describe("mergePluginConfig", () => {
    const pluginBlock = {
      plugins: {
        enabled: true,
        allow: ["agenthifive"],
        entries: {
          agenthifive: {
            enabled: true,
            config: { baseUrl: "https://example.com" },
          },
        },
      },
    };

    it("merges into empty config", () => {
      const result = mergePluginConfig({}, pluginBlock);
      const plugins = result.plugins as Record<string, unknown>;
      assert.equal(plugins.enabled, true);
      assert.deepEqual(plugins.allow, ["agenthifive"]);
      const entries = plugins.entries as Record<string, unknown>;
      assert.ok(entries.agenthifive);
    });

    it("preserves existing non-agenthifive plugins", () => {
      const existing = {
        plugins: {
          enabled: true,
          allow: ["other-plugin"],
          entries: {
            "other-plugin": { enabled: true, config: {} },
          },
        },
      };
      const result = mergePluginConfig(existing, pluginBlock);
      const plugins = result.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, unknown>;
      assert.ok(entries["other-plugin"]);
      assert.ok(entries.agenthifive);
    });

    it("deduplicates allow list", () => {
      const existing = {
        plugins: {
          allow: ["agenthifive", "other"],
        },
      };
      const result = mergePluginConfig(existing, pluginBlock);
      const plugins = result.plugins as Record<string, unknown>;
      const allow = plugins.allow as string[];
      assert.equal(allow.filter((a: string) => a === "agenthifive").length, 1);
      assert.ok(allow.includes("other"));
    });

    it("replaces existing agenthifive entry entirely", () => {
      const existing = {
        plugins: {
          entries: {
            agenthifive: { enabled: false, config: { baseUrl: "old" } },
          },
        },
      };
      const result = mergePluginConfig(existing, pluginBlock);
      const plugins = result.plugins as Record<string, unknown>;
      const entries = plugins.entries as Record<string, unknown>;
      const ah5 = entries.agenthifive as Record<string, unknown>;
      assert.equal(ah5.enabled, true);
      assert.equal((ah5.config as Record<string, unknown>).baseUrl, "https://example.com");
    });

    it("preserves non-plugin config keys", () => {
      const existing = {
        gateway: { port: 8080 },
        channels: { telegram: {} },
        plugins: {},
      };
      const result = mergePluginConfig(existing, pluginBlock);
      assert.deepEqual(result.gateway, { port: 8080 });
      assert.deepEqual(result.channels, { telegram: {} });
    });

    it("removes legacy native channel entries when AgentHiFive channel config is merged", () => {
      const existing = {
        channels: {
          telegram: { botToken: "native-token" },
          slack: { enabled: true, mode: "socket" },
        },
        plugins: {
          enabled: true,
          allow: ["telegram", "slack"],
          entries: {
            telegram: { enabled: true },
            slack: { enabled: true },
          },
        },
      };
      const result = mergePluginConfig(existing, {
        channels: {
          agenthifive: {
            accounts: {
              default: {
                enabled: true,
                providers: {
                  telegram: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
                  slack: { enabled: true },
                },
              },
            },
          },
        },
      });

      const channels = result.channels as Record<string, unknown>;
      assert.equal("telegram" in channels, false);
      assert.equal("slack" in channels, false);
      assert.ok(channels.agenthifive);

      const plugins = result.plugins as Record<string, unknown>;
      const allow = plugins.allow as string[];
      const entries = plugins.entries as Record<string, unknown>;
      assert.equal(allow.includes("telegram"), false);
      assert.equal(allow.includes("slack"), false);
      assert.equal("telegram" in entries, false);
      assert.equal("slack" in entries, false);
    });

    it("merges block without plugins key (agents-only update)", () => {
      const existing = {
        plugins: {
          enabled: true,
          allow: ["agenthifive"],
          entries: { agenthifive: { enabled: true, config: { baseUrl: "https://example.com" } } },
        },
      };
      const agentsOnly = {
        agents: { defaults: { model: "openai/gpt-4.1" } },
      };
      const result = mergePluginConfig(existing, agentsOnly);
      // plugins should be preserved untouched
      const plugins = result.plugins as Record<string, unknown>;
      assert.equal(plugins.enabled, true);
      const entries = plugins.entries as Record<string, unknown>;
      assert.ok(entries.agenthifive);
      // agents should be merged
      const agents = result.agents as { defaults: { model: string } };
      assert.equal(agents.defaults.model, "openai/gpt-4.1");
    });

    it("merges agents.defaults.model", () => {
      const existing = {
        agents: {
          defaults: { maxTokens: 4096 },
          list: [{ name: "my-agent" }],
        },
      };
      const blockWithAgents = {
        ...pluginBlock,
        agents: {
          defaults: { model: "openai/gpt-4.1" },
        },
      };
      const result = mergePluginConfig(existing, blockWithAgents);
      const agents = result.agents as { defaults: { model: string; maxTokens: number }; list: unknown[] };
      assert.equal(agents.defaults.model, "openai/gpt-4.1");
      assert.equal(agents.defaults.maxTokens, 4096);
      assert.ok(agents.list, "preserves non-defaults agent keys");
    });

    it("merges tools.alsoAllow with deduplication", () => {
      const existing = {
        tools: { alsoAllow: ["custom_tool"], profile: "coding" },
      };
      const blockWithTools = {
        ...pluginBlock,
        tools: { alsoAllow: ["group:plugins"] },
      };
      const result = mergePluginConfig(existing, blockWithTools);
      const tools = result.tools as { alsoAllow: string[]; profile: string };
      assert.ok(tools.alsoAllow.includes("group:plugins"));
      assert.ok(tools.alsoAllow.includes("custom_tool"));
      assert.equal(tools.profile, "coding", "preserves existing tools keys");
    });

    it("merges models.providers for LLM proxy", () => {
      const existing = {
        models: {
          providers: {
            existing: { baseUrl: "https://existing.com", apiKey: "key" },
          },
        },
      };
      const blockWithModels = {
        ...pluginBlock,
        models: {
          providers: {
            anthropic: { baseUrl: "https://vault/v1/vault/llm/anthropic", apiKey: "vault-managed" },
          },
        },
      };
      const result = mergePluginConfig(existing, blockWithModels);
      const models = result.models as { providers: Record<string, { baseUrl: string }> };
      assert.ok(models.providers.existing);
      assert.ok(models.providers.anthropic);
      assert.equal(models.providers.anthropic.baseUrl, "https://vault/v1/vault/llm/anthropic");
    });
  });
});
