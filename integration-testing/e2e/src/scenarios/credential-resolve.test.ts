/**
 * E2E Scenario 2: Credential Resolution
 *
 * Tests: use agent access token to resolve credentials from the vault.
 * Exercises POST /v1/credentials/resolve with different provider types.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../helpers/fixture.js";
import { apiRequest } from "../helpers/agent-auth.js";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const fixture = loadFixture();

describe("Scenario 2: Credential Resolution", () => {
  it("resolves Telegram bot token via channel credential", async () => {
    const response = await apiRequest("POST", "/v1/credentials/resolve", fixture.creds.accessToken, {
      kind: "channel",
      provider: "telegram",
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    const body = (await response.json()) as { apiKey: string; source: string; mode: string };

    assert.ok(body.apiKey, "Should return apiKey");
    assert.equal(
      body.apiKey,
      "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ",
      "Should return the seeded Telegram bot token",
    );
    assert.ok(body.source, "Should include source info");
  });

  it("resolves OpenAI API key via model_provider credential", async () => {
    const response = await apiRequest("POST", "/v1/credentials/resolve", fixture.creds.accessToken, {
      kind: "model_provider",
      provider: "openai",
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    const body = (await response.json()) as { apiKey: string; source: string };

    assert.ok(body.apiKey, "Should return apiKey");
    assert.equal(
      body.apiKey,
      "sk-test-mock-openai-api-key-for-e2e",
      "Should return the seeded OpenAI API key",
    );
  });

  it("returns 404 for unknown provider", async () => {
    const response = await apiRequest("POST", "/v1/credentials/resolve", fixture.creds.accessToken, {
      kind: "model_provider",
      provider: "nonexistent-provider",
    });

    assert.equal(response.status, 404, "Unknown provider should return 404");
  });

  it("rejects unauthenticated credential resolve", async () => {
    const response = await fetch(`${AH5_API_URL}/v1/credentials/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "channel", provider: "telegram" }),
    });

    assert.equal(response.status, 401, "Should require authentication");
  });
});
