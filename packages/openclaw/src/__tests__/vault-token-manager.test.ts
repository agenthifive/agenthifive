import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTokenExchangeFailure } from "../../dist/vault-token-manager.js";

describe("vault-token-manager", () => {
  it("classifies clock skew failures from structured 401 responses", () => {
    const err = new Error('Token exchange failed: 401 {"error":"Invalid client assertion","reason":"clock_skew"}');
    assert.equal(classifyTokenExchangeFailure(err), "clock_skew");
  });

  it("classifies transient fetch failures as network issues", () => {
    const err = new Error("fetch failed");
    assert.equal(classifyTokenExchangeFailure(err), "network");
  });

  it("classifies other 401s as invalid key failures", () => {
    const err = new Error('Token exchange failed: 401 {"error":"Invalid client assertion"}');
    assert.equal(classifyTokenExchangeFailure(err), "invalid_key");
  });
});
