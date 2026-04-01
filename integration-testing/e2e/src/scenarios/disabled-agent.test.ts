/**
 * E2E Scenario 6: Disabled Agent
 *
 * Tests: disabling an agent immediately invalidates token exchange.
 * Uses direct DB updates to toggle agent status.
 *
 * IMPORTANT: This must run last — it mutates the agent's status.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { agents } from "../../../../apps/api/src/db/schema/agents.js";
import { loadFixture } from "../helpers/fixture.js";
import { signClientAssertion, exchangeToken } from "../helpers/agent-auth.js";
import { importJWK, type KeyLike } from "jose";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const fixture = loadFixture();

const connectionString =
  process.env["DATABASE_URL"] ||
  "postgresql://agenthifive:test-password@postgres:5432/agenthifive_test";

describe("Scenario 6: Disabled Agent", () => {
  const sql = postgres(connectionString);
  const db = drizzle(sql);

  after(async () => {
    // Restore agent to active state and clean up
    await db
      .update(agents)
      .set({ status: "active", disabledAt: null })
      .where(eq(agents.id, fixture.seed.agentId));
    await sql.end();
  });

  it("rejects token exchange for disabled agent", async () => {
    // Disable the agent via direct DB update
    await db
      .update(agents)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(agents.id, fixture.seed.agentId));

    // Import the private key to sign a new assertion
    const privateKeyObj = (await importJWK(fixture.creds.privateKey, "ES256")) as KeyLike;
    const assertion = await signClientAssertion(privateKeyObj, fixture.seed.agentId);

    const response = await fetch(`${AH5_API_URL}/v1/agents/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_assertion",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });

    assert.equal(response.status, 401, "Disabled agent should be rejected");
    const body = (await response.json()) as { error: string };
    assert.ok(
      body.error.toLowerCase().includes("not active") ||
        body.error.toLowerCase().includes("invalid agent"),
      `Error should mention agent status, got: ${body.error}`,
    );
  });

  it("allows token exchange after re-enabling agent", async () => {
    // Re-enable the agent
    await db
      .update(agents)
      .set({ status: "active", disabledAt: null })
      .where(eq(agents.id, fixture.seed.agentId));

    // Import the private key to sign a new assertion
    const privateKeyObj = (await importJWK(fixture.creds.privateKey, "ES256")) as KeyLike;
    const assertion = await signClientAssertion(privateKeyObj, fixture.seed.agentId);
    const tokenResult = await exchangeToken(assertion);

    assert.ok(tokenResult.access_token, "Should receive a new access token");
    assert.ok(
      tokenResult.access_token.startsWith("ah5t_"),
      "Token should have ah5t_ prefix",
    );
    assert.equal(tokenResult.token_type, "Bearer");
    assert.ok(tokenResult.expires_in > 0, "Token should have positive TTL");
  });
});
