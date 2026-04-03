import { describe, it } from "node:test";
import assert from "node:assert/strict";

import setupPlugin from "../../dist/setup-entry.js";

describe("AgentHiFive channel config", () => {
  it("does not auto-enable Telegram or Slack when providers are missing", () => {
    const cfg = setupPlugin.plugin.setup.applyAccountConfig({
      cfg: {},
      accountId: "default",
      input: {
        name: "Primary",
        token: "ah5t_demo",
        url: "https://vault.example.com",
      },
    });

    const account = setupPlugin.plugin.config.resolveAccount(cfg, "default");
    assert.equal(account.telegramEnabled, false);
    assert.equal(account.slackEnabled, false);
  });

  it("keeps explicit provider toggles enabled", () => {
    const account = setupPlugin.plugin.config.resolveAccount(
      {
        channels: {
          agenthifive: {
            accounts: {
              default: {
                enabled: true,
                baseUrl: "https://vault.example.com",
                auth: { mode: "bearer", token: "ah5t_demo" },
                providers: {
                  telegram: { enabled: true, dmPolicy: "balanced", allowFrom: [] },
                  slack: { enabled: true },
                },
              },
            },
          },
        },
      },
      "default",
    );

    assert.equal(account.telegramEnabled, true);
    assert.equal(account.slackEnabled, true);
  });
});
