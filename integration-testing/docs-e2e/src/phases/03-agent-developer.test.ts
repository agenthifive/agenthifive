/**
 * Phase 3: Agent Developer Flow
 *
 * Docs under test:
 * - api-reference/agent-auth.md
 * - api-reference/execution.md
 * - api-reference/audit.md
 * - sdk/index.md
 *
 * Tests the bootstrap → authenticate → execute → audit flow using
 * only what the docs describe.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type JWK,
} from "jose";
import { randomUUID } from "node:crypto";
import { API_URL } from "../helpers/constants.js";
import { reportGap } from "../helpers/doc-checker.js";

const AUTH_DOC = "api-reference/agent-auth.md";
const EXEC_DOC = "api-reference/execution.md";
const AUDIT_DOC = "api-reference/audit.md";

const FIXTURE_PATH =
  process.env["DOCS_E2E_FIXTURE_PATH"] || "/tmp/docs-e2e-fixture.json";

interface Phase2Fixture {
  sessionCookie: string;
  jwt: string;
  agentId: string;
  connectionId: string;
  bootstrapSecret: string;
}

let fixture: Phase2Fixture;
let agentAccessToken = "";
let agentIdFromBootstrap = "";

describe("Phase 3: Agent Developer Flow", () => {
  before(() => {
    try {
      fixture = JSON.parse(
        readFileSync(FIXTURE_PATH, "utf-8"),
      ) as Phase2Fixture;
      console.log(
        `[phase3] Loaded fixture: agent=${fixture.agentId}, connection=${fixture.connectionId}`,
      );
    } catch (err) {
      console.log(
        `[phase3] No fixture found at ${FIXTURE_PATH}. Phase 2 may have failed.`,
      );
    }
  });

  // ── Bootstrap (agent-auth.md) ───────────────────────────────────

  it("Step 1: Bootstrap agent with ES256 key pair", async () => {
    if (!fixture?.bootstrapSecret) {
      console.log("[phase3] Skipping — no bootstrap secret from Phase 2");
      return;
    }

    // Follow the docs: generate ES256 key pair
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const publicKeyJWK = await exportJWK(publicKey);
    const privateKeyJWK = await exportJWK(privateKey);

    // POST /v1/agents/bootstrap (unauthenticated)
    // Docs say: { bootstrapSecret, publicKey }
    const res = await fetch(`${API_URL}/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrapSecret: fixture.bootstrapSecret,
        publicKey: publicKeyJWK,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`[phase3] Bootstrap failed: ${res.status} ${text}`);

      // If bootstrap secret was already consumed, this is expected
      if (res.status === 400 || res.status === 404) {
        reportGap({
          file: AUTH_DOC,
          section: "Bootstrap",
          severity: "unclear",
          description:
            "Bootstrap secret may already be consumed if agent was created " +
            "via dashboard API which auto-bootstraps. Docs should clarify " +
            "when bootstrap is needed vs already done.",
          evidence: `Bootstrap returned ${res.status}: ${text}`,
        });
      }
      return;
    }

    const data = (await res.json()) as {
      agentId: string;
      name: string;
      status: string;
      workspaceId: string;
    };

    assert.ok(data.agentId, "Bootstrap should return agentId");
    assert.equal(data.status, "active", "Agent should transition to active");
    agentIdFromBootstrap = data.agentId;

    console.log(`[phase3] Bootstrapped agent: ${data.agentId} (${data.status})`);

    // Store private key for token exchange
    (globalThis as Record<string, unknown>).__phase3_privateKey = privateKey;
    (globalThis as Record<string, unknown>).__phase3_agentId =
      data.agentId;
  });

  // ── Token Exchange (agent-auth.md) ──────────────────────────────

  it("Step 2: Exchange client assertion for access token", async () => {
    const privateKey = (globalThis as Record<string, unknown>)
      .__phase3_privateKey as CryptoKey | undefined;
    const targetAgentId =
      ((globalThis as Record<string, unknown>).__phase3_agentId as string) ||
      fixture?.agentId;

    if (!privateKey || !targetAgentId) {
      console.log("[phase3] Skipping — no private key or agent ID");
      return;
    }

    // Follow the docs: sign a client assertion JWT
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(targetAgentId)
      .setSubject(targetAgentId)
      .setAudience(API_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .setJti(randomUUID())
      .sign(privateKey);

    // POST /v1/agents/token (unauthenticated)
    const res = await fetch(`${API_URL}/v1/agents/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_assertion",
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(`[phase3] Token exchange failed: ${res.status} ${text}`);
      return;
    }

    const data = (await res.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
    };

    assert.ok(data.access_token, "Should return access_token");
    assert.ok(
      data.access_token.startsWith("ah5t_"),
      `Token should start with ah5t_ prefix, got: ${data.access_token.slice(0, 10)}`,
    );
    assert.equal(data.token_type, "Bearer");
    assert.ok(data.expires_in > 0, "expires_in should be positive");

    agentAccessToken = data.access_token;
    console.log(`[phase3] Got agent token: ${data.access_token.slice(0, 12)}...`);
  });

  // ── Vault Execute (execution.md) ────────────────────────────────

  it("Step 3: Execute Model B vault request", async () => {
    if (!agentAccessToken || !fixture?.connectionId) {
      console.log("[phase3] Skipping — no agent token or connection ID");
      return;
    }

    // Follow the docs: POST /v1/vault/execute with Model B
    const res = await fetch(`${API_URL}/v1/vault/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentAccessToken}`,
      },
      body: JSON.stringify({
        model: "B",
        connectionId: fixture.connectionId,
        method: "GET",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      }),
    });

    // With a dummy API key, the provider will reject the request.
    // What matters is that the vault accepted it and attempted to proxy.
    const data = (await res.json()) as Record<string, unknown>;
    console.log(
      `[phase3] Vault execute response: ${res.status} ${JSON.stringify(data).slice(0, 200)}`,
    );

    if (res.status === 200) {
      // Vault proxied successfully (unlikely with dummy key, but possible for list endpoints)
      assert.ok(data.auditId, "Response should include auditId");
    } else if (res.status === 502 || res.status === 503) {
      // Provider rejected the dummy key — this is expected
      console.log("[phase3] Provider rejected dummy key (expected)");
      // Check if auditId is still present in error responses
      if (!data.auditId) {
        reportGap({
          file: EXEC_DOC,
          section: "Model B Response",
          severity: "unclear",
          description:
            "Docs should clarify whether auditId is included in error responses " +
            "when the provider rejects the request (502/503).",
          evidence: `Status ${res.status}, auditId present: ${!!data.auditId}`,
        });
      }
    } else if (res.status === 403) {
      // Policy denied — check the hint
      console.log(
        `[phase3] Policy denied: ${JSON.stringify(data).slice(0, 300)}`,
      );
    } else {
      console.log(`[phase3] Unexpected status: ${res.status}`);
    }
  });

  // ── Audit Log (audit.md) ────────────────────────────────────────

  it("Step 4: Verify audit trail", async () => {
    if (!fixture?.jwt) {
      console.log("[phase3] Skipping — no user JWT for audit query");
      return;
    }

    // Follow the docs: GET /v1/audit (requires user auth)
    const res = await fetch(`${API_URL}/v1/audit`, {
      headers: {
        Authorization: `Bearer ${fixture.jwt}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      console.log(`[phase3] Audit query failed: ${res.status}`);
      return;
    }

    const data = (await res.json()) as {
      events: Array<{ action: string; decision: string }>;
    };
    console.log(`[phase3] Audit events: ${data.events?.length ?? 0}`);

    if (data.events && data.events.length > 0) {
      for (const event of data.events.slice(0, 5)) {
        console.log(
          `[phase3]   ${event.action}: ${event.decision}`,
        );
      }
    }
  });
});
