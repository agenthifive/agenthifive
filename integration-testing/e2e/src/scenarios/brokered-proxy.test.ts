/**
 * E2E Scenario 3: Brokered Proxy (Model B)
 *
 * Tests: agent makes a Model B vault/execute request that gets proxied
 * through the echo server. Validates the full policy -> proxy -> response cycle.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../helpers/fixture.js";
import { apiRequest } from "../helpers/agent-auth.js";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const fixture = loadFixture();

describe("Scenario 3: Brokered Proxy (Model B)", () => {
  it("proxies GET request through echo server", async () => {
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "GET",
      url: "http://echo:8080/test-path",
      connectionId: fixture.seed.telegramConnectionId,
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    const body = (await response.json()) as {
      status: number;
      headers: Record<string, string>;
      body: unknown;
      auditId: string;
    };

    assert.ok(body.auditId, "Should include auditId");
    assert.equal(body.status, 200, "Proxied response should be 200 from echo server");
  });

  it("proxies POST request with body through echo server", async () => {
    const payload = { message: "hello from E2E test" };
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "POST",
      url: "http://echo:8080/data",
      connectionId: fixture.seed.telegramConnectionId,
      headers: { "Content-Type": "application/json" },
      body: payload,
    });

    assert.equal(response.status, 200, `Expected 200, got ${response.status}`);
    const body = (await response.json()) as {
      status: number;
      body: unknown;
      auditId: string;
    };

    assert.ok(body.auditId, "Should include auditId");
    assert.equal(body.status, 200, "Proxied response should be 200");
  });

  it("rejects unauthenticated vault/execute", async () => {
    const response = await fetch(`${AH5_API_URL}/v1/vault/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "B",
        method: "GET",
        url: "http://echo:8080/test",
        connectionId: fixture.seed.telegramConnectionId,
      }),
    });

    assert.equal(response.status, 401, "Should require authentication");
  });
});
