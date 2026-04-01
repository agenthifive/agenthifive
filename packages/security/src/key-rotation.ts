/**
 * Key rotation support for re-encrypting stored tokens
 * when the encryption key changes.
 *
 * Usage:
 *   const result = await rotateKey(oldKey, newKey, fetchRows, updateRow);
 *
 * The caller provides fetch/update callbacks so this module
 * stays database-agnostic.
 */

import { encrypt, decrypt, type EncryptedPayload } from "./encryption.js";

/** A row containing encrypted data that needs re-encryption */
export interface EncryptedRow {
  /** Row identifier (e.g., connection UUID) */
  id: string;
  /** The encrypted tokens stored as JSON string of EncryptedPayload */
  encryptedTokens: string;
}

/** Result of a key rotation operation */
export interface KeyRotationResult {
  /** Total rows processed */
  total: number;
  /** Rows successfully re-encrypted */
  succeeded: number;
  /** Rows that failed re-encryption */
  failed: number;
  /** IDs of rows that failed */
  failedIds: string[];
}

/**
 * Re-encrypt all stored tokens from oldKey to newKey.
 *
 * @param oldKey - Current encryption key (hex string or Buffer)
 * @param newKey - New encryption key (hex string or Buffer)
 * @param fetchRows - Callback to fetch all rows with encrypted data
 * @param updateRow - Callback to update a single row with new encrypted data
 * @returns Summary of the rotation operation
 */
export async function rotateKey(
  oldKey: Buffer | string,
  newKey: Buffer | string,
  fetchRows: () => Promise<EncryptedRow[]>,
  updateRow: (id: string, newEncryptedTokens: string) => Promise<void>,
): Promise<KeyRotationResult> {
  const rows = await fetchRows();
  const result: KeyRotationResult = {
    total: rows.length,
    succeeded: 0,
    failed: 0,
    failedIds: [],
  };

  for (const row of rows) {
    try {
      // Decrypt with old key
      const encryptedPayload: EncryptedPayload = JSON.parse(row.encryptedTokens);
      const plaintext = decrypt(encryptedPayload, oldKey);

      // Re-encrypt with new key
      const newPayload = encrypt(plaintext, newKey);
      const newEncryptedTokens = JSON.stringify(newPayload);

      // Persist
      await updateRow(row.id, newEncryptedTokens);
      result.succeeded++;
    } catch {
      result.failed++;
      result.failedIds.push(row.id);
    }
  }

  return result;
}
