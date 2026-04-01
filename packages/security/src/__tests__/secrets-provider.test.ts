import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  EnvSecretsProvider,
  VaultSecretsProvider,
  createSecretsProvider,
} from "../secrets-provider.ts";

describe("EnvSecretsProvider", () => {
  let provider: EnvSecretsProvider;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    provider = new EnvSecretsProvider();
  });

  afterEach(() => {
    // Restore any env vars we modified
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function clearEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  it("reads a secret from environment variable", async () => {
    setEnv("MY_SECRET", "secret-value");
    const value = await provider.getSecret("MY_SECRET");
    assert.equal(value, "secret-value");
  });

  it("returns undefined for missing secret", async () => {
    clearEnv("NONEXISTENT_SECRET_KEY");
    const value = await provider.getSecret("NONEXISTENT_SECRET_KEY");
    assert.equal(value, undefined);
  });

  it("normalizes key with dots and slashes to uppercase underscored", async () => {
    setEnv("OAUTH_GOOGLE_CLIENT_ID", "my-client-id");
    const value = await provider.getSecret("oauth/google.client_id");
    assert.equal(value, "my-client-id");
  });

  it("sets a secret in environment", async () => {
    const key = "TEST_SET_SECRET_" + Date.now();
    savedEnv[key] = process.env[key]; // track for cleanup
    await provider.setSecret(key, "new-value");
    assert.equal(process.env[key], "new-value");
  });

  it("normalizes key when setting", async () => {
    const envKey = "SOME_PATH_KEY";
    savedEnv[envKey] = process.env[envKey];
    await provider.setSecret("some/path.key", "val");
    assert.equal(process.env[envKey], "val");
  });
});

describe("VaultSecretsProvider", () => {
  it("throws if no token provided", () => {
    const saved = process.env["VAULT_TOKEN"];
    delete process.env["VAULT_TOKEN"];
    try {
      assert.throws(
        () => new VaultSecretsProvider({ token: "" }),
        /VAULT_TOKEN/,
      );
    } finally {
      if (saved !== undefined) {
        process.env["VAULT_TOKEN"] = saved;
      }
    }
  });

  it("accepts options for endpoint, token, and mountPath", () => {
    // Should not throw with explicit token
    const provider = new VaultSecretsProvider({
      endpoint: "http://localhost:8200",
      token: "test-token",
      mountPath: "kv",
    });
    assert.ok(provider);
  });
});

describe("createSecretsProvider", () => {
  it("creates EnvSecretsProvider by default", () => {
    const saved = process.env["SECRETS_PROVIDER"];
    delete process.env["SECRETS_PROVIDER"];
    try {
      const provider = createSecretsProvider();
      assert.ok(provider instanceof EnvSecretsProvider);
    } finally {
      if (saved !== undefined) {
        process.env["SECRETS_PROVIDER"] = saved;
      }
    }
  });

  it("creates EnvSecretsProvider for 'env'", () => {
    const provider = createSecretsProvider("env");
    assert.ok(provider instanceof EnvSecretsProvider);
  });

  it("creates VaultSecretsProvider for 'vault'", () => {
    const saved = process.env["VAULT_TOKEN"];
    process.env["VAULT_TOKEN"] = "test-token";
    try {
      const provider = createSecretsProvider("vault");
      assert.ok(provider instanceof VaultSecretsProvider);
    } finally {
      if (saved !== undefined) {
        process.env["VAULT_TOKEN"] = saved;
      } else {
        delete process.env["VAULT_TOKEN"];
      }
    }
  });

  it("throws for unknown provider", () => {
    assert.throws(
      () => createSecretsProvider("unknown"),
      /Unknown secrets provider: unknown/,
    );
  });

  it("reads SECRETS_PROVIDER from environment", () => {
    const saved = process.env["SECRETS_PROVIDER"];
    process.env["SECRETS_PROVIDER"] = "env";
    try {
      const provider = createSecretsProvider();
      assert.ok(provider instanceof EnvSecretsProvider);
    } finally {
      if (saved !== undefined) {
        process.env["SECRETS_PROVIDER"] = saved;
      } else {
        delete process.env["SECRETS_PROVIDER"];
      }
    }
  });
});
