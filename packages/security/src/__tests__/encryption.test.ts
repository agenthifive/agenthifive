import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encrypt, decrypt, generateEncryptionKey } from "../encryption.ts";

describe("encryption", () => {
  const key = generateEncryptionKey();

  it("encrypts and decrypts a simple string", () => {
    const plaintext = "hello world";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("encrypts and decrypts an empty string", () => {
    const plaintext = "";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("encrypts and decrypts unicode text", () => {
    const plaintext = "日本語テスト 🔐 émojis";
    const encrypted = encrypt(plaintext, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, plaintext);
  });

  it("encrypts and decrypts a JSON payload (like OAuth tokens)", () => {
    const tokenPayload = JSON.stringify({
      access_token: "ya29.a0AfH6SMBx...",
      refresh_token: "1//0gX...",
      expires_in: 3600,
      scope: "openid email profile",
    });
    const encrypted = encrypt(tokenPayload, key);
    const decrypted = decrypt(encrypted, key);
    assert.equal(decrypted, tokenPayload);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    const plaintext = "same input";
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it("returns a valid envelope with version and algorithm", () => {
    const encrypted = encrypt("test", key);
    assert.equal(encrypted.v, 1);
    assert.equal(encrypted.alg, "A256GCM");
    assert.ok(encrypted.iv.length > 0);
    assert.ok(encrypted.ciphertext.length > 0);
    assert.ok(encrypted.tag.length > 0);
  });

  it("fails to decrypt with wrong key", () => {
    const encrypted = encrypt("secret data", key);
    const wrongKey = generateEncryptionKey();
    assert.throws(() => decrypt(encrypted, wrongKey));
  });

  it("fails to decrypt with tampered ciphertext", () => {
    const encrypted = encrypt("secret data", key);
    const tampered = { ...encrypted, ciphertext: "AAAA" + encrypted.ciphertext.slice(4) };
    assert.throws(() => decrypt(tampered, key));
  });

  it("fails to decrypt with tampered tag", () => {
    const encrypted = encrypt("secret data", key);
    const tampered = { ...encrypted, tag: "AAAA" + encrypted.tag.slice(4) };
    assert.throws(() => decrypt(tampered, key));
  });

  it("rejects keys of wrong length", () => {
    assert.throws(() => encrypt("test", "abcd"), /Encryption key must be 32 bytes/);
    assert.throws(() => decrypt({ v: 1, alg: "A256GCM", iv: "", ciphertext: "", tag: "" }, "abcd"), /Encryption key must be 32 bytes/);
  });

  it("accepts Buffer keys", () => {
    const bufKey = Buffer.from(key, "hex");
    const encrypted = encrypt("buffer key test", bufKey);
    const decrypted = decrypt(encrypted, bufKey);
    assert.equal(decrypted, "buffer key test");
  });

  it("generateEncryptionKey returns 64 hex chars (32 bytes)", () => {
    const k = generateEncryptionKey();
    assert.equal(k.length, 64);
    assert.match(k, /^[0-9a-f]{64}$/);
  });
});
