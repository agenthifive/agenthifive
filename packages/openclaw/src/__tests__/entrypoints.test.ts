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
  });
});
