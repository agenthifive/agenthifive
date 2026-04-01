import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rotateKey } from "../../dist/key-rotation.js";
import { encrypt, decrypt, generateEncryptionKey, type EncryptedPayload } from "../encryption.ts";

describe("rotateKey", () => {
  it("re-encrypts all rows from old key to new key", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();

    // Create test data encrypted with old key
    const rows = [
      { id: "row-1", encryptedTokens: JSON.stringify(encrypt("secret-1", oldKey)) },
      { id: "row-2", encryptedTokens: JSON.stringify(encrypt("secret-2", oldKey)) },
      { id: "row-3", encryptedTokens: JSON.stringify(encrypt("secret-3", oldKey)) },
    ];

    const updates: Map<string, string> = new Map();

    const result = await rotateKey(
      oldKey,
      newKey,
      async () => rows,
      async (id, newEncryptedTokens) => { updates.set(id, newEncryptedTokens); },
    );

    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 3);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedIds, []);

    // Verify new ciphertexts decrypt with new key
    for (const [id, encStr] of updates) {
      const payload: EncryptedPayload = JSON.parse(encStr);
      const plaintext = decrypt(payload, newKey);
      const rowIndex = rows.findIndex((r) => r.id === id);
      assert.equal(plaintext, `secret-${rowIndex + 1}`);
    }

    // Verify new ciphertexts do NOT decrypt with old key
    for (const [, encStr] of updates) {
      const payload: EncryptedPayload = JSON.parse(encStr);
      assert.throws(() => decrypt(payload, oldKey));
    }
  });

  it("handles empty row set", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();

    const result = await rotateKey(
      oldKey,
      newKey,
      async () => [],
      async () => { throw new Error("should not be called"); },
    );

    assert.equal(result.total, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 0);
    assert.deepEqual(result.failedIds, []);
  });

  it("tracks failures for rows that cannot be decrypted", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();
    const wrongKey = generateEncryptionKey();

    const rows = [
      { id: "good-1", encryptedTokens: JSON.stringify(encrypt("data-1", oldKey)) },
      { id: "bad-1", encryptedTokens: JSON.stringify(encrypt("data-2", wrongKey)) }, // wrong key
      { id: "good-2", encryptedTokens: JSON.stringify(encrypt("data-3", oldKey)) },
    ];

    const updates: Map<string, string> = new Map();

    const result = await rotateKey(
      oldKey,
      newKey,
      async () => rows,
      async (id, newEncryptedTokens) => { updates.set(id, newEncryptedTokens); },
    );

    assert.equal(result.total, 3);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failedIds, ["bad-1"]);
    assert.ok(updates.has("good-1"));
    assert.ok(updates.has("good-2"));
    assert.ok(!updates.has("bad-1"));
  });

  it("tracks failures for rows with invalid JSON", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();

    const rows = [
      { id: "good", encryptedTokens: JSON.stringify(encrypt("data", oldKey)) },
      { id: "invalid-json", encryptedTokens: "not-json{" },
    ];

    const updates: Map<string, string> = new Map();

    const result = await rotateKey(
      oldKey,
      newKey,
      async () => rows,
      async (id, newEncryptedTokens) => { updates.set(id, newEncryptedTokens); },
    );

    assert.equal(result.total, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failedIds, ["invalid-json"]);
  });

  it("tracks failures when updateRow throws", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();

    const rows = [
      { id: "row-1", encryptedTokens: JSON.stringify(encrypt("data-1", oldKey)) },
      { id: "row-2", encryptedTokens: JSON.stringify(encrypt("data-2", oldKey)) },
    ];

    const result = await rotateKey(
      oldKey,
      newKey,
      async () => rows,
      async (id) => {
        if (id === "row-2") {
          throw new Error("DB write failed");
        }
      },
    );

    assert.equal(result.total, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failedIds, ["row-2"]);
  });

  it("preserves JSON token payload through rotation", async () => {
    const oldKey = generateEncryptionKey();
    const newKey = generateEncryptionKey();

    const tokenPayload = JSON.stringify({
      accessToken: "ya29.xxx",
      refreshToken: "1//0gX",
      tokenType: "Bearer",
      expiresAt: "2026-12-01T00:00:00Z",
    });

    const rows = [
      { id: "conn-1", encryptedTokens: JSON.stringify(encrypt(tokenPayload, oldKey)) },
    ];

    const updates: Map<string, string> = new Map();

    await rotateKey(
      oldKey,
      newKey,
      async () => rows,
      async (id, newEncryptedTokens) => { updates.set(id, newEncryptedTokens); },
    );

    const newPayload: EncryptedPayload = JSON.parse(updates.get("conn-1")!);
    const decrypted = decrypt(newPayload, newKey);
    assert.deepEqual(JSON.parse(decrypted), JSON.parse(tokenPayload));
  });
});
