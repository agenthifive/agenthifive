import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * JTI Replay Cache Tests
 *
 * Tests the PostgreSQL-backed jti cache used for client assertion replay protection.
 * Requires the test database to be running (port 5433).
 */

import { checkAndStoreJti, clearJtiCache } from "../../utils/jti-cache.js";

describe("JTI Replay Cache", () => {
  beforeEach(async () => {
    await clearJtiCache();
  });

  it("allows first use of a jti", async () => {
    const result = await checkAndStoreJti("jti-001", Date.now() + 60_000);
    assert.equal(result, true);
  });

  it("rejects replay of same jti", async () => {
    const expiry = Date.now() + 60_000;
    await checkAndStoreJti("jti-002", expiry);
    const result = await checkAndStoreJti("jti-002", expiry);
    assert.equal(result, false);
  });

  it("allows reuse of jti after expiry", async () => {
    // Store with an already-expired time
    await checkAndStoreJti("jti-003", Date.now() - 1000);
    // Should be allowed because the previous entry has expired
    // checkAndStoreJti detects the expired row and cleans it up
    const result = await checkAndStoreJti("jti-003", Date.now() + 60_000);
    assert.equal(result, true);
  });

  it("handles multiple distinct jtis independently", async () => {
    const expiry = Date.now() + 60_000;
    assert.equal(await checkAndStoreJti("jti-a", expiry), true);
    assert.equal(await checkAndStoreJti("jti-b", expiry), true);
    assert.equal(await checkAndStoreJti("jti-c", expiry), true);

    // Replays should fail
    assert.equal(await checkAndStoreJti("jti-a", expiry), false);
    assert.equal(await checkAndStoreJti("jti-b", expiry), false);

    // New jti should still work
    assert.equal(await checkAndStoreJti("jti-d", expiry), true);
  });

  it("clearJtiCache resets all entries", async () => {
    const expiry = Date.now() + 60_000;
    await checkAndStoreJti("jti-clear-1", expiry);
    await checkAndStoreJti("jti-clear-2", expiry);

    await clearJtiCache();

    // After clearing, both should be allowed again
    assert.equal(await checkAndStoreJti("jti-clear-1", expiry), true);
    assert.equal(await checkAndStoreJti("jti-clear-2", expiry), true);
  });
});
