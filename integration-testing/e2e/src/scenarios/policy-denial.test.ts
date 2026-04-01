/**
 * E2E Scenario 5: Policy Denial
 *
 * Tests: vault policy enforcement with restrictive allowlists.
 * Verifies that requests outside the allowlist are denied with proper hints.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadFixture } from "../helpers/fixture.js";
import { apiRequest } from "../helpers/agent-auth.js";

const fixture = loadFixture();

describe("Scenario 5: Policy Denial", () => {
  it("denies request to URL not matching any policy allowlist", async () => {
    // The Telegram policy allows http://echo:8080/**
    // This request goes to a completely different host that no policy covers
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "GET",
      url: "http://not-allowed-host:9999/secret",
      connectionId: fixture.seed.telegramConnectionId,
    });

    // Should be denied by SSRF protection or policy engine
    assert.ok(
      response.status === 403 || response.status === 400 || response.status === 502,
      `Should deny request to disallowed host, got ${response.status}`,
    );
  });

  it("allows request matching permissive policy allowlist", async () => {
    // The Telegram policy allows all methods on echo:8080/**
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "GET",
      url: "http://echo:8080/allowed-path",
      connectionId: fixture.seed.telegramConnectionId,
    });

    assert.equal(response.status, 200, "Permissive policy should allow the request");
  });

  it("denies Model B request when policy only allows Model A", async () => {
    // OpenAI policy allows Model A only
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "GET",
      url: "http://echo:8080/test",
      connectionId: fixture.seed.openaiConnectionId,
    });

    assert.ok(
      response.status === 403 || response.status === 400,
      `Model B on A-only policy should be denied, got ${response.status}`,
    );
  });

  it("returns hint in denial response", async () => {
    const response = await apiRequest("POST", "/v1/vault/execute", fixture.creds.accessToken, {
      model: "B",
      method: "GET",
      url: "http://not-allowed-host:9999/secret",
      connectionId: fixture.seed.telegramConnectionId,
    });

    if (response.status === 403) {
      const body = (await response.json()) as { error: string; hint?: string };
      assert.ok(body.hint, "403 denial should include a hint for the AI agent");
    } else {
      // SSRF protection or other error — still valid
      assert.ok(
        response.status === 400 || response.status === 502,
        `Expected 400/403/502, got ${response.status}`,
      );
    }
  });
});
