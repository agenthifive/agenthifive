import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { VaultCredentialProvider } from "../../dist/vault-provider.js";

const BASE_URL = "https://vault.test.local";
const DEFAULT_CONFIG = {
  baseUrl: BASE_URL,
  auth: { mode: "api_key" as const, apiKey: "test-key" },
  timeoutMs: 5000,
  cacheTtlMs: 60_000,
};

describe("VaultCredentialProvider", () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = mock.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("has id 'agenthifive-vault'", () => {
    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    assert.equal(provider.id, "agenthifive-vault");
  });

  it("resolve() always returns null (agents use vault/execute)", async () => {
    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const result = await provider.resolve({ kind: "model_provider", provider: "openai" });

    assert.equal(result, null);
    assert.equal(fetchMock.mock.callCount(), 0, "should not make any HTTP call");
  });

  it("resolve() returns null for channel queries too", async () => {
    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const result = await provider.resolve({ kind: "channel", provider: "slack" });

    assert.equal(result, null);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("isAvailable returns true when health endpoint responds ok", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.resolve({ ok: true }),
    );

    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const available = await provider.isAvailable?.();

    assert.equal(available, true);
    assert.equal(fetchMock.mock.callCount(), 1);
    const callUrl = fetchMock.mock.calls[0]!.arguments[0];
    assert.equal(callUrl, `${BASE_URL}/health`);
  });

  it("isAvailable returns false when health endpoint fails", async () => {
    fetchMock.mock.mockImplementationOnce(() =>
      Promise.reject(new Error("ECONNREFUSED")),
    );

    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const available = await provider.isAvailable?.();

    assert.equal(available, false);
  });

  it("buildAuthHeaders uses X-API-Key for api_key mode", () => {
    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const headers = provider.buildAuthHeaders();
    assert.equal(headers["X-API-Key"], "test-key");
  });

  it("buildAuthHeaders uses Bearer for bearer mode", () => {
    const provider = new VaultCredentialProvider({
      ...DEFAULT_CONFIG,
      auth: { mode: "bearer", token: "jwt-token-123" },
    });
    const headers = provider.buildAuthHeaders();
    assert.equal(headers["Authorization"], "Bearer jwt-token-123");
  });

  it("getConfig returns the provider configuration", () => {
    const provider = new VaultCredentialProvider(DEFAULT_CONFIG);
    const config = provider.getConfig();
    assert.equal(config.baseUrl, BASE_URL);
    assert.equal(config.timeoutMs, 5000);
  });
});
