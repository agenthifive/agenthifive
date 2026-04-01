/**
 * Centralized encryption key provider.
 *
 * Supports two modes (selected via ENCRYPTION_KEY_MODE env var):
 *  - "env"      (default) — reads ENCRYPTION_KEY from process.env (dev/test/CI)
 *  - "azure-kv" — unwraps a DEK from Azure Key Vault at startup (production)
 *
 * Call initEncryptionKey() once at app startup (before route registration).
 * Then use getEncryptionKey() synchronously in any route handler.
 */

let _key: string | null = null;

/**
 * Initialize the encryption key. Must be called once at startup.
 * In "env" mode, reads from process.env. In "azure-kv" mode, unwraps
 * a Data Encryption Key from Azure Key Vault (requires network access).
 */
export async function initEncryptionKey(): Promise<void> {
  const mode = process.env["ENCRYPTION_KEY_MODE"] || "env";

  if (mode === "env") {
    _key = process.env["ENCRYPTION_KEY"] || "";
    console.log("Encryption key initialized (env mode)");
    return;
  }

  if (mode === "azure-kv") {
    console.log("Encryption key: unwrapping DEK from Azure Key Vault...");
    const { unwrapDataKey } = await import("@agenthifive/security");
    _key = await unwrapDataKey({
      vaultUri: process.env["AZURE_KEY_VAULT_URI"]!,
      keyName: process.env["AZURE_KV_KEK_NAME"] || "data-encryption-kek",
      wrappedDekSecretName: process.env["AZURE_KV_WRAPPED_DEK_SECRET"] || "WRAPPED-DATA-KEY",
      managedIdentityClientId: process.env["AZURE_MANAGED_IDENTITY_CLIENT_ID"],
    });
    console.log("Encryption key initialized (azure-kv mode)");
    return;
  }

  throw new Error(`Unknown ENCRYPTION_KEY_MODE: ${mode}`);
}

/**
 * Get the encryption key synchronously.
 *
 * In production, initEncryptionKey() must be called first (throws if not).
 * In env mode, lazily reads from process.env as a convenience for tests
 * that register routes without calling buildApp().
 */
export function getEncryptionKey(): string {
  if (_key === null) {
    // Lazy init for env mode (tests that skip buildApp)
    const envKey = process.env["ENCRYPTION_KEY"];
    if (envKey) {
      _key = envKey;
      return _key;
    }
    throw new Error("Encryption key not initialized. Call initEncryptionKey() at startup.");
  }
  return _key;
}
