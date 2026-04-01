import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  setVaultBearerToken,
  setCredentialProvider,
  setProxiedProviders,
  getVaultBearerToken,
  getProxiedProviders,
  resolveCredential,
  isInitialized,
} from "../../dist/runtime.js";

describe("runtime", () => {
  beforeEach(() => {
    // Reset state
    setVaultBearerToken(null);
    setCredentialProvider(null);
    setProxiedProviders([]);
  });

  describe("isInitialized", () => {
    it("returns false when nothing is set", () => {
      assert.equal(isInitialized(), false);
    });

    it("returns true when bearer token is set", () => {
      setVaultBearerToken("ah5t_test_token");
      assert.equal(isInitialized(), true);
    });

    it("returns true when credential provider is set", () => {
      setCredentialProvider({
        id: "test-provider",
        resolve: async () => null,
        isAvailable: async () => true,
      });
      assert.equal(isInitialized(), true);
    });
  });

  describe("vault bearer token", () => {
    it("starts as null", () => {
      assert.equal(getVaultBearerToken(), null);
    });

    it("stores and retrieves a token", () => {
      setVaultBearerToken("ah5t_my_token");
      assert.equal(getVaultBearerToken(), "ah5t_my_token");
    });

    it("can be cleared by setting null", () => {
      setVaultBearerToken("ah5t_my_token");
      setVaultBearerToken(null);
      assert.equal(getVaultBearerToken(), null);
    });

    it("updates in place when token refreshes", () => {
      setVaultBearerToken("ah5t_old");
      assert.equal(getVaultBearerToken(), "ah5t_old");
      setVaultBearerToken("ah5t_new");
      assert.equal(getVaultBearerToken(), "ah5t_new");
    });
  });

  describe("proxied providers", () => {
    it("starts as empty array", () => {
      assert.deepEqual(getProxiedProviders(), []);
    });

    it("stores and retrieves provider list", () => {
      setProxiedProviders(["openai", "anthropic"]);
      assert.deepEqual(getProxiedProviders(), ["openai", "anthropic"]);
    });
  });

  describe("resolveCredential", () => {
    it("returns null when no provider is set", async () => {
      const result = await resolveCredential({
        kind: "model_provider",
        provider: "openai",
      });
      assert.equal(result, null);
    });

    it("delegates to credential provider and adapts result", async () => {
      setCredentialProvider({
        id: "test-vault",
        resolve: async (query) => {
          assert.equal(query.provider, "openai");
          return { token: "sk-test-key", expiresAt: Date.now() + 3600_000 };
        },
        isAvailable: async () => true,
      });

      const result = await resolveCredential({
        kind: "model_provider",
        provider: "openai",
      });

      assert.ok(result);
      assert.equal(result.apiKey, "sk-test-key");
      assert.equal(result.source, "credential-provider:test-vault");
      assert.equal(result.mode, "api-key");
    });

    it("returns null when provider returns null", async () => {
      setCredentialProvider({
        id: "empty-provider",
        resolve: async () => null,
        isAvailable: async () => true,
      });

      const result = await resolveCredential({
        kind: "model_provider",
        provider: "unknown-provider",
      });

      assert.equal(result, null);
    });

    it("passes fields as scopes to internal provider", async () => {
      let capturedScopes: string[] | undefined;

      setCredentialProvider({
        id: "scope-checker",
        resolve: async (query) => {
          capturedScopes = query.scopes;
          return null;
        },
        isAvailable: async () => true,
      });

      await resolveCredential({
        kind: "model_provider",
        provider: "openai",
        fields: ["apiKey", "orgId"],
      });

      assert.deepEqual(capturedScopes, ["apiKey", "orgId"]);
    });

    it("does not pass scopes when fields is undefined", async () => {
      let queryReceived: { provider: string; scopes?: string[] } | null = null;

      setCredentialProvider({
        id: "no-scope-checker",
        resolve: async (query) => {
          queryReceived = query;
          return null;
        },
        isAvailable: async () => true,
      });

      await resolveCredential({
        kind: "model_provider",
        provider: "anthropic",
      });

      assert.ok(queryReceived);
      assert.equal("scopes" in queryReceived!, false);
    });
  });
});
