import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM parameters */
const ALGORITHM = "aes-256-gcm" as const;
const IV_LENGTH = 12; // 96 bits, recommended for GCM
const TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

/** Result of an AES-256-GCM encryption operation */
export interface EncryptedPayload {
  /** Envelope version for future algorithm migration */
  v: 1;
  /** Algorithm identifier */
  alg: "A256GCM";
  /** Initialization vector (base64url) */
  iv: string;
  /** Encrypted data (base64url) */
  ciphertext: string;
  /** GCM authentication tag (base64url) */
  tag: string;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Generates a random IV per operation for semantic security.
 *
 * @param plaintext - The string to encrypt
 * @param key - 32-byte encryption key (Buffer or hex string)
 * @returns Encrypted payload with IV, ciphertext, and auth tag
 */
export function encrypt(plaintext: string, key: Buffer | string): EncryptedPayload {
  const keyBuffer = typeof key === "string" ? Buffer.from(key, "hex") : key;

  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 8} bits), got ${keyBuffer.length} bytes`);
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: "A256GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload.
 *
 * @param payload - The encrypted payload (iv, ciphertext, tag)
 * @param key - 32-byte encryption key (Buffer or hex string)
 * @returns Decrypted plaintext string
 */
export function decrypt(payload: EncryptedPayload, key: Buffer | string): string {
  const keyBuffer = typeof key === "string" ? Buffer.from(key, "hex") : key;

  if (keyBuffer.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 8} bits), got ${keyBuffer.length} bytes`);
  }

  const iv = Buffer.from(payload.iv, "base64url");
  const ciphertext = Buffer.from(payload.ciphertext, "base64url");
  const tag = Buffer.from(payload.tag, "base64url");

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf8");
}

/**
 * Generate a random 256-bit encryption key.
 * @returns Hex-encoded 32-byte key
 */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_LENGTH).toString("hex");
}
