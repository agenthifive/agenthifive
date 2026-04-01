/**
 * E2E Scenario 1: Full Agent Bootstrap Flow
 *
 * The bootstrap and token exchange were already performed by the orchestrator.
 * This file validates that the bootstrap consumed the secret and the endpoints
 * reject invalid inputs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../helpers/fixture.js";
import { generateAgentKeyPair, signClientAssertion, exchangeToken } from "../helpers/agent-auth.js";
import { importJWK, type KeyLike } from "jose";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const fixture = loadFixture();

describe("Scenario 1: Agent Bootstrap E2E", () => {
  it("bootstrap was successful (verified from fixture)", () => {
    assert.ok(fixture.creds.agentId, "Agent should be bootstrapped");
    assert.ok(fixture.creds.accessToken, "Access token should be present");
    assert.ok(
      fixture.creds.accessToken.startsWith("ah5t_"),
      "Token should have ah5t_ prefix",
    );
  });

  it("rejects re-bootstrap with consumed secret", async () => {
    const { publicKeyJWK } = await generateAgentKeyPair();

    const response = await fetch(`${AH5_API_URL}/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: fixture.seed.bootstrapSecret,
        publicKey: publicKeyJWK,
      }),
    });

    assert.equal(response.status, 401, "Consumed bootstrap secret should be rejected");
  });

  it("exchanges client assertion for access token using bootstrapped key", async () => {
    const privateKeyObj = (await importJWK(fixture.creds.privateKey, "ES256")) as KeyLike;
    const assertion = await signClientAssertion(privateKeyObj, fixture.creds.agentId);
    const result = await exchangeToken(assertion);

    assert.ok(result.access_token.startsWith("ah5t_"), "Token should have ah5t_ prefix");
    assert.equal(result.token_type, "Bearer");
    assert.ok(result.expires_in > 0, "Token should have positive TTL");
  });

  it("rejects bootstrap with wrong prefix", async () => {
    const { publicKeyJWK } = await generateAgentKeyPair();

    const response = await fetch(`${AH5_API_URL}/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: "wrong_prefix_secret",
        publicKey: publicKeyJWK,
      }),
    });

    assert.equal(response.status, 401, "Wrong prefix should be rejected");
  });

  it("API health check is accessible", async () => {
    const response = await fetch(`${AH5_API_URL}/health`);
    assert.equal(response.status, 200, "Health endpoint should be accessible");
  });
});
