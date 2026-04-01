import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { verifyTurnstileToken } from "../../utils/turnstile.js";

// Cloudflare Turnstile test secret keys
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const TEST_SECRET_ALWAYS_PASSES = "1x0000000000000000000000000000000AA";
const TEST_SECRET_ALWAYS_FAILS = "2x0000000000000000000000000000000AB";
const TEST_SECRET_TOKEN_SPENT = "3x0000000000000000000000000000000AB";

// Any non-empty string works as a token with test keys
const DUMMY_TOKEN = "test-token";

describe("verifyTurnstileToken", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env["TURNSTILE_SECRET_KEY"];
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env["TURNSTILE_SECRET_KEY"] = originalKey;
    } else {
      delete process.env["TURNSTILE_SECRET_KEY"];
    }
  });

  it("skips verification when TURNSTILE_SECRET_KEY is not set", async () => {
    delete process.env["TURNSTILE_SECRET_KEY"];
    const result = await verifyTurnstileToken(undefined);
    assert.equal(result, true);
  });

  it("rejects when secret is set but no token provided", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_ALWAYS_PASSES;
    const result = await verifyTurnstileToken(undefined);
    assert.equal(result, false);
  });

  it("rejects empty string token", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_ALWAYS_PASSES;
    const result = await verifyTurnstileToken("");
    assert.equal(result, false);
  });

  it("accepts valid token with always-passes test key", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_ALWAYS_PASSES;
    const result = await verifyTurnstileToken(DUMMY_TOKEN);
    assert.equal(result, true);
  });

  it("rejects token with always-fails test key", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_ALWAYS_FAILS;
    const result = await verifyTurnstileToken(DUMMY_TOKEN);
    assert.equal(result, false);
  });

  it("rejects token with token-already-spent test key", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_TOKEN_SPENT;
    const result = await verifyTurnstileToken(DUMMY_TOKEN);
    assert.equal(result, false);
  });

  it("passes remoteIp to Cloudflare when provided", async () => {
    process.env["TURNSTILE_SECRET_KEY"] = TEST_SECRET_ALWAYS_PASSES;
    const result = await verifyTurnstileToken(DUMMY_TOKEN, "203.0.113.1");
    assert.equal(result, true);
  });
});
