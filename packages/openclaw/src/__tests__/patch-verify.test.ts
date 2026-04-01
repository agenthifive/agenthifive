import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifyPatches } from "../../dist/patch-verify.js";

describe("patch-verify", () => {
  it("returns modelAuth: false when not running inside OpenClaw", async () => {
    // In our test environment, we're not inside an OpenClaw installation,
    // so model-auth.ts doesn't exist and the patch can't be detected.
    const warnings: string[] = [];
    const result = await verifyPatches({
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    });

    assert.equal(result.modelAuth, false);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]!.includes("model-auth patch not detected"));
    assert.ok(warnings[0]!.includes("LLM credential proxying is unavailable"));
  });

  it("returns PatchStatus shape", async () => {
    const result = await verifyPatches({ info: () => {}, warn: () => {}, error: () => {} });
    assert.equal(typeof result, "object");
    assert.equal(typeof result.modelAuth, "boolean");
  });
});
