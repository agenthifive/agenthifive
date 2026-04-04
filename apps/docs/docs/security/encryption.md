---
title: Encryption
sidebar_position: 2
sidebar_label: Encryption
description: AES-256-GCM envelope encryption, key providers (KMS, Vault Transit, age), and key rotation strategy.
---

# Encryption

AgentHiFive encrypts all provider OAuth tokens at rest using **AES-256-GCM**. When running in Azure Key Vault mode (`azure-kv`), envelope encryption adds a second layer of key protection. This page covers the encryption architecture, supported key providers, and rotation strategy.

## Envelope Encryption

:::note Azure Key Vault Only
Envelope encryption (DEK/KEK separation) is only implemented for the `azure-kv` key mode. In the default `env` mode, a single encryption key from the `ENCRYPTION_KEY` environment variable is used directly -- there is no DEK/KEK separation.
:::

Envelope encryption uses two layers of keys:

- **Data Encryption Key (DEK)** -- encrypts the actual data (provider tokens). A single DEK is unwrapped from Azure Key Vault at startup.
- **Key Encryption Key (KEK)** -- encrypts (wraps) the DEK. Managed by Azure Key Vault. Never exposed to the application.

This separation means the application only ever sees the DEK in memory during encrypt/decrypt operations. The KEK never leaves the Key Vault boundary.

### Encrypted Payload Format

Every encrypted token is stored as a versioned payload:

```typescript
interface EncryptedPayload {
  v: 1;                    // Payload version (for algorithm agility)
  alg: "A256GCM";         // Encryption algorithm
  iv: string;              // Initialization vector (base64url)
  ciphertext: string;      // Encrypted payload (base64url)
  tag: string;             // GCM authentication tag (base64url)
}
```

The `v` and `alg` fields enable future migration to different algorithms (including post-quantum) without changing the storage schema.

:::info Key Modes
In `env` mode (default), the `ENCRYPTION_KEY` environment variable is used directly as the encryption key. In `azure-kv` mode, a wrapped DEK is unwrapped from Azure Key Vault at startup using a KEK, providing true envelope encryption. See [Self-Host Security](./self-host-security.md#key-initialization-modes) for configuration details.
:::

## Key Providers

### AWS KMS (SaaS Production)

AWS KMS provides a managed HSM-backed key store with automatic rotation and CloudTrail audit logging.

```bash
# Create the master key
aws kms create-key --description "AgentHiFive master key" --key-usage ENCRYPT_DECRYPT
aws kms create-alias --alias-name alias/agenthifive-master --target-key-id <key-id>
```

The application calls `GenerateDataKey` to get a plaintext DEK and its KMS-encrypted form, encrypts the token locally with the DEK, then stores only the ciphertext and encrypted DEK. On decryption, KMS decrypts the DEK, and the application decrypts the token locally.

### Vault Transit (Self-Hosted Production)

HashiCorp Vault Transit provides encryption-as-a-service with versioned keys and zero-downtime rotation.

```bash
vault secrets enable transit
vault write -f transit/keys/workspace-keys
```

Vault Transit handles key versioning transparently. Old ciphertexts (e.g., `vault:v1:...`) continue to decrypt even after key rotation. An optional rewrap operation upgrades old ciphertexts to the latest key version.

### age Encryption (Self-Hosted Simple)

For simple deployments without Vault or cloud KMS, [age](https://github.com/FiloSottile/age) provides file-based asymmetric encryption for DEK wrapping.

```bash
age-keygen -o /secure/master.key
```

:::warning
With age, key rotation is a manual process: generate a new key, re-encrypt all DEKs, and swap the key file. This must be planned and scripted from day one.
:::

## Key Rotation

### Rotation Schedule

| Asset | Frequency | Trigger |
|-------|-----------|---------|
| KEK (master key) | Every 365 days | Scheduled |
| DEK (workspace key) | Every 90 days | Scheduled |
| Emergency rotation | Immediate | Key compromise suspected |

### Manual Re-encryption

:::warning No Automatic Background Rewrap
There is no automatic background re-encryption job. Key rotation and re-encryption of existing records is a manual process using the `rotate-data-key.sh` script.
:::

To re-encrypt tokens after rotating the encryption key:

1. Generate a new key and update `ENCRYPTION_KEY` (or rotate the KEK in Azure Key Vault).
2. Run the `rotate-data-key.sh` script to re-encrypt all stored tokens with the new key.
3. Restart the API service.

### Emergency Rotation Procedure

1. **Detect** -- suspected key compromise via alert, unusual access, or breach notification.
2. **Rotate immediately** -- create a new key version in KMS/Vault/age.
3. **Rewrap all tokens** -- run the rewrap job with `olderThanDays = 0`.
4. **Audit** -- review CloudTrail or Vault audit logs for unauthorized access.
5. **Notify** -- alert affected users if tokens may have been exposed.
6. **Post-mortem** -- document cause, timeline, and remediation.

## Quantum Resistance

AES-256-GCM is quantum-safe. Grover's algorithm reduces effective security to approximately 128 bits, which remains computationally infeasible. No migration is needed for the token encryption layer.

For JWT signing (RSA/ECDSA) and passkeys (WebAuthn/ECDSA), migration to post-quantum algorithms (ML-DSA / FIPS 204) will occur when library support is available. The current design supports this through configurable signing algorithms and multi-key JWKS endpoints.
