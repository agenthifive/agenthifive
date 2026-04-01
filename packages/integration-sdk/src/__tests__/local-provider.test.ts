import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LocalCredentialProvider } from "../../dist/local-provider.js";

describe("LocalCredentialProvider", () => {
  it("has id 'local'", () => {
    const provider = new LocalCredentialProvider();
    assert.equal(provider.id, "local");
  });

  it("always returns null for model_provider queries", async () => {
    const provider = new LocalCredentialProvider();
    const result = await provider.resolve({
      kind: "model_provider",
      provider: "openai",
    });
    assert.equal(result, null);
  });

  it("always returns null for channel queries", async () => {
    const provider = new LocalCredentialProvider();
    const result = await provider.resolve({
      kind: "channel",
      provider: "telegram",
      profileId: "bot1",
    });
    assert.equal(result, null);
  });

  it("always returns null for plugin_config queries", async () => {
    const provider = new LocalCredentialProvider();
    const result = await provider.resolve({
      kind: "plugin_config",
      provider: "notion",
      fields: ["apiKey"],
    });
    assert.equal(result, null);
  });
});
