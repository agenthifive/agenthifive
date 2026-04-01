---
title: Encryption
sidebar_position: 2
sidebar_label: Encryption
description: AES-256-GCM envelope encryption, key providers (KMS, Vault Transit, age), and key rotation strategy.
---

# Encryption

AgentHiFive encrypts all provider OAuth tokens at rest using **AES-256-GCM** with **envelope encryption**. This page covers the encryption architecture, supported key providers, and rotation strategy.

## Envelope Encryption

Envelope encryption uses two layers of keys:

- **Data Encryption Key (DEK)** -- encrypts the actual data (provider tokens). Generated per workspace.
- **Key Encryption Key (KEK)** -- encrypts the DEKs. Managed by an external KMS or key provider. Never exposed to the application.

This separation means the application only ever sees the DEK in memory during encrypt/decrypt operations. The KEK never leaves the KMS boundary.

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

:::info Planned: Full Envelope Encryption
The current implementation uses a single encryption key per workspace. Full envelope encryption with separate DEKs wrapped by a KEK (via AWS KMS, Vault Transit, or age) is planned for production deployment. The `v` field will increment when this layer is added.
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

### Background Rewrap

A background job periodically re-encrypts tokens with the current key version to reduce the exposure window:

```typescript
async function rewrapOldTokens(olderThanDays = 90) {
  const staleTokens = await db.query.oauthTokenSets.findMany({
    where: lt(oauthTokenSets.lastRotatedAt, subDays(new Date(), olderThanDays)),
  });

  for (const token of staleTokens) {
    const plaintext = await decrypt(token);
    const newEnvelope = await encrypt(plaintext);
    await db.update(oauthTokenSets).set({
      ciphertext: newEnvelope.ciphertext,
      encryptionKeyVersion: newEnvelope.version,
      lastRotatedAt: new Date(),
    }).where(eq(oauthTokenSets.id, token.id));
  }
}
```

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
