/**
 * Azure Key Vault envelope encryption.
 *
 * Uses an RSA-2048 Key Encryption Key (KEK) in Key Vault to wrap/unwrap
 * an AES-256 Data Encryption Key (DEK). The KEK never leaves Key Vault;
 * the wrapped DEK is stored as a Key Vault secret.
 *
 * At app startup, the wrapped DEK is fetched and unwrapped via KV API.
 * The unwrapped DEK is cached in memory for local AES-256-GCM operations.
 *
 * Requires: @azure/identity, @azure/keyvault-keys, @azure/keyvault-secrets
 * (dynamically imported — not needed in dev/test mode)
 */

export interface AzureKvCryptoConfig {
  /** Key Vault URI, e.g. "https://kv-prod-ah5.vault.azure.net" */
  vaultUri: string;
  /** Name of the RSA KEK in Key Vault */
  keyName: string;
  /** Name of the KV secret holding the wrapped DEK (base64) */
  wrappedDekSecretName: string;
  /** Client ID of the user-assigned Managed Identity (optional) */
  managedIdentityClientId?: string | undefined;
}

/**
 * Unwrap the Data Encryption Key from Azure Key Vault.
 *
 * 1. Fetches the wrapped DEK from a Key Vault secret
 * 2. Unwraps it using the RSA KEK via Key Vault's Crypto API
 * 3. Returns the raw AES-256 key as a hex string
 */
export async function unwrapDataKey(config: AzureKvCryptoConfig): Promise<string> {
  const { ManagedIdentityCredential, DefaultAzureCredential } = await import("@azure/identity");
  const { KeyClient, CryptographyClient } = await import("@azure/keyvault-keys");
  const { SecretClient } = await import("@azure/keyvault-secrets");

  // Create credential — prefer Managed Identity if client ID is provided
  const credential = config.managedIdentityClientId
    ? new ManagedIdentityCredential(config.managedIdentityClientId)
    : new DefaultAzureCredential();

  // 1. Fetch the wrapped DEK from Key Vault secret
  const secretClient = new SecretClient(config.vaultUri, credential);
  const secret = await secretClient.getSecret(config.wrappedDekSecretName);
  if (!secret.value) {
    throw new Error(`Key Vault secret "${config.wrappedDekSecretName}" is empty`);
  }
  const wrappedDek = Buffer.from(secret.value, "base64");

  // 2. Get the KEK reference and create a CryptographyClient
  const keyClient = new KeyClient(config.vaultUri, credential);
  const key = await keyClient.getKey(config.keyName);
  if (!key.id) {
    throw new Error(`Key Vault key "${config.keyName}" not found`);
  }
  const cryptoClient = new CryptographyClient(key.id, credential);

  // 3. Unwrap the DEK using RSA-OAEP-256
  const result = await cryptoClient.unwrapKey("RSA-OAEP-256", wrappedDek);

  // 4. Return as hex string (AES-256 = 32 bytes = 64 hex chars)
  return Buffer.from(result.result).toString("hex");
}

/**
 * Wrap a Data Encryption Key using the KEK in Azure Key Vault.
 * Returns the wrapped DEK as a base64 string (for storage as a KV secret).
 *
 * Used by seed/rotation scripts — not called at app runtime.
 */
export async function wrapDataKey(
  config: AzureKvCryptoConfig,
  dekHex: string,
): Promise<string> {
  const { ManagedIdentityCredential, DefaultAzureCredential } = await import("@azure/identity");
  const { KeyClient, CryptographyClient } = await import("@azure/keyvault-keys");

  const credential = config.managedIdentityClientId
    ? new ManagedIdentityCredential(config.managedIdentityClientId)
    : new DefaultAzureCredential();

  const keyClient = new KeyClient(config.vaultUri, credential);
  const key = await keyClient.getKey(config.keyName);
  if (!key.id) {
    throw new Error(`Key Vault key "${config.keyName}" not found`);
  }
  const cryptoClient = new CryptographyClient(key.id, credential);

  const dekBuffer = Buffer.from(dekHex, "hex");
  const result = await cryptoClient.wrapKey("RSA-OAEP-256", dekBuffer);

  return Buffer.from(result.result).toString("base64");
}
