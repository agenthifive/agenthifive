import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { ChainedCredentialProvider } from "../../dist/chained-provider.js";

describe("ChainedCredentialProvider", () => {
  it("has id 'chained'", () => {
    const chain = new ChainedCredentialProvider([]);
    assert.equal(chain.id, "chained");
  });

  it("returns result from first provider that resolves non-null", async () => {
    const p1Resolve = mock.fn(() => Promise.resolve(null));
    const p2Resolve = mock.fn(() =>
      Promise.resolve({ apiKey: "from-p2", source: "test", mode: "api-key" as const }),
    );

    const p1 = { id: "empty", resolve: p1Resolve };
    const p2 = { id: "found", resolve: p2Resolve };

    const chain = new ChainedCredentialProvider([p1, p2]);
    const result = await chain.resolve({ kind: "model_provider", provider: "openai" });

    assert.equal(result?.apiKey, "from-p2");
    assert.equal(p1Resolve.mock.callCount(), 1);
    assert.equal(p2Resolve.mock.callCount(), 1);
  });

  it("returns null when all providers return null", async () => {
    const p1 = { id: "a", resolve: mock.fn(() => Promise.resolve(null)) };
    const p2 = { id: "b", resolve: mock.fn(() => Promise.resolve(null)) };

    const chain = new ChainedCredentialProvider([p1, p2]);
    const result = await chain.resolve({ kind: "model_provider", provider: "unknown" });

    assert.equal(result, null);
  });

  it("stops at first non-null result (does not call remaining providers)", async () => {
    const p1Resolve = mock.fn(() => Promise.resolve({ apiKey: "early", source: "test" }));
    const p2Resolve = mock.fn(() => Promise.resolve(null));

    const p1 = { id: "found", resolve: p1Resolve };
    const p2 = { id: "skipped", resolve: p2Resolve };

    const chain = new ChainedCredentialProvider([p1, p2]);
    await chain.resolve({ kind: "channel", provider: "slack" });

    assert.equal(p1Resolve.mock.callCount(), 1);
    assert.equal(p2Resolve.mock.callCount(), 0);
  });
});
