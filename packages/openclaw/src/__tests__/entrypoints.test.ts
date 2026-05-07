import { describe, it } from "node:test";
import assert from "node:assert/strict";
import pkg from "../../package.json" with { type: "json" };
import manifest from "../../openclaw.plugin.json" with { type: "json" };

import plugin from "../../dist/register.js";
import channelPlugin from "../../dist/channel-entry.js";
import setupPlugin from "../../dist/setup-entry.js";

describe("package entrypoints", () => {
  it("keeps the generic plugin entry intact", () => {
    assert.equal(plugin.id, "agenthifive");
    assert.equal(typeof plugin.register, "function");
  });

  it("exports a real channel entry", () => {
    assert.equal(channelPlugin.id, "agenthifive");
    assert.equal(channelPlugin.name, "AgentHiFive Channels");
    assert.equal(typeof channelPlugin.register, "function");
    assert.ok(channelPlugin.configSchema.schema.properties.proxiedProviders);
  });

  it("exports a setup entry bound to the channel plugin", () => {
    assert.equal(setupPlugin.plugin.id, "agenthifive");
    assert.equal(setupPlugin.plugin.meta.label, "AgentHiFive");
  });

  it("wires setup and config adapters for native channel accounts", async () => {
    const nextCfg = setupPlugin.plugin.setup.applyAccountConfig({
      cfg: {},
      accountId: "default",
      input: {
        name: "Primary",
        token: "ah5t_demo",
        url: "https://vault.example.com",
      },
    });

    const account = setupPlugin.plugin.config.resolveAccount(nextCfg, "default");
    assert.equal(account.accountId, "default");
    assert.equal(account.baseUrl, "https://vault.example.com");
    assert.equal(account.auth?.mode, "bearer");
    assert.equal(account.dmPolicy, "balanced");
    assert.equal(await setupPlugin.plugin.config.isConfigured?.(account, nextCfg), true);
  });

  it("declares channel-plugin-ready package metadata", () => {
    assert.equal(pkg.openclaw.setupEntry, "./dist/setup-entry.js");
    assert.equal(pkg.openclaw.channel.id, "agenthifive");
    assert.ok(pkg.openclaw.channel.blurb.includes("Slack"));
    assert.deepEqual(manifest.channels, ["agenthifive"]);
    assert.equal(manifest.version, pkg.version);
    assert.ok(manifest.channelConfigs?.agenthifive?.schema);
    assert.ok(manifest.configSchema.properties.proxiedProviders);
  });

  it("accepts latest OpenClaw nested plugin config shape", async () => {
    const logs: string[] = [];
    const registeredTools: unknown[] = [];
    const handlers: Array<{ event: string; handler: unknown }> = [];

    plugin.register({
      pluginConfig: {
        enabled: true,
        config: {
          baseUrl: "https://vault.example.com",
          auth: { mode: "bearer", token: "ah5t_demo" },
          proxiedProviders: ["gemini"],
          connectedProviders: ["telegram"],
        },
      },
      logger: {
        info: (msg: string) => logs.push(msg),
        warn: (msg: string) => logs.push(msg),
        error: (msg: string) => logs.push(msg),
      },
      registerTool: (tool: unknown) => registeredTools.push(tool),
      on: (event: string, handler: unknown) => handlers.push({ event, handler }),
    });

    assert.ok(logs.some((line) => line.includes("ready")));
    assert.equal(registeredTools.length, 7);
    assert.ok(handlers.some((entry) => entry.event === "before_agent_start"));
  });

  it("registers vault tools when latest OpenClaw loads channel setup-runtime", async () => {
    const registeredTools: Array<{ name?: string }> = [];
    const handlers: Array<{ event: string; handler: unknown }> = [];

    channelPlugin.register({
      registrationMode: "setup-runtime",
      pluginConfig: {
        baseUrl: "https://vault.example.com",
        auth: { mode: "bearer", token: "ah5t_demo" },
        proxiedProviders: ["gemini"],
        connectedProviders: ["telegram", "gmail"],
      },
      config: {},
      runtime: {},
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      registerChannel: () => undefined,
      registerTool: (tool: { name?: string }) => registeredTools.push(tool),
      on: (event: string, handler: unknown) => handlers.push({ event, handler }),
    });

    assert.ok(registeredTools.some((tool) => tool.name === "vault_connections_list"));
    assert.ok(registeredTools.some((tool) => tool.name === "vault_execute"));
    assert.ok(handlers.some((entry) => entry.event === "before_agent_start"));
  });
});
