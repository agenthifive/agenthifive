/**
 * E2E Scenario 4: VaultClient Agent Mode
 *
 * Tests: the packages/openclaw VaultClient with mode:"agent" (ES256 private_key_jwt).
 * Validates that the VaultClient auto-exchanges JWT assertions for access tokens
 * and makes authenticated API calls without manual token management.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../helpers/fixture.js";
import { VaultClient } from "../../../../packages/openclaw/src/client.js";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const TOKEN_AUDIENCE = process.env["AGENT_TOKEN_AUDIENCE"] || AH5_API_URL;
const fixture = loadFixture();

describe("Scenario 4: VaultClient Agent Mode", () => {
  it("auto-exchanges JWT for token and resolves credentials", async () => {
    const client = new VaultClient({
      baseUrl: AH5_API_URL,
      auth: {
        mode: "agent",
        privateKey: fixture.creds.privateKey as JsonWebKey,
        agentId: fixture.creds.agentId,
        tokenAudience: TOKEN_AUDIENCE,
      },
    });

    const result = await client.post<{
      apiKey: string;
      source: string;
    }>("/v1/credentials/resolve", {
      kind: "channel",
      provider: "telegram",
    });

    assert.ok(result.apiKey, "Should return apiKey");
    assert.equal(
      result.apiKey,
      "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ",
      "Should return the seeded Telegram bot token",
    );
  });

  it("VaultClient in bearer mode works with pre-exchanged token", async () => {
    const client = new VaultClient({
      baseUrl: AH5_API_URL,
      auth: {
        mode: "bearer",
        token: fixture.creds.accessToken,
      },
    });

    const result = await client.post<{
      apiKey: string;
      source: string;
    }>("/v1/credentials/resolve", {
      kind: "model_provider",
      provider: "openai",
    });

    assert.ok(result.apiKey, "Should return apiKey");
    assert.equal(
      result.apiKey,
      "sk-test-mock-openai-api-key-for-e2e",
      "Should return the seeded OpenAI API key",
    );
  });

  it("VaultClient handles vault/execute in agent mode", async () => {
    const client = new VaultClient({
      baseUrl: AH5_API_URL,
      auth: {
        mode: "agent",
        privateKey: fixture.creds.privateKey as JsonWebKey,
        agentId: fixture.creds.agentId,
        tokenAudience: TOKEN_AUDIENCE,
      },
    });

    const result = await client.post<{
      status: number;
      body: unknown;
      auditId: string;
    }>("/v1/vault/execute", {
      model: "B",
      method: "GET",
      url: "http://echo:8080/vault-client-test",
      connectionId: fixture.seed.telegramConnectionId,
    });

    assert.ok(result.auditId, "Should include auditId");
    assert.equal(result.status, 200, "Proxied response should be 200");
  });
});
