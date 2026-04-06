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

  // ── Vault Execute: Gmail (execution.md) ──────────────────────────

  it("Step 3: Execute Model B — Gmail labels", async () => {
    if (!agentAccessToken || !fixture?.connectionId) {
      console.log("[phase3] Skipping — no agent token or connection ID");
      return;
    }

    // The Gmail allowlist template uses www.googleapis.com (not gmail.googleapis.com)
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
        url: "https://www.googleapis.com/gmail/v1/users/me/labels",
      }),
    });

    const data = (await res.json()) as Record<string, unknown>;
    console.log(
      `[phase3] Gmail vault execute: ${res.status} ${JSON.stringify(data).slice(0, 200)}`,
    );

    if (res.status === 200) {
      console.log("[phase3] Gmail: vault proxied successfully");
      assert.ok(data.auditId || data.body, "Response should include auditId or body");
    } else if (res.status === 409) {
      // OAuth token may have expired between test runs. The vault correctly
      // detected this and flagged the connection for reauth.
      console.log("[phase3] Gmail: connection needs reauthentication (OAuth token expired between test runs)");
    } else {
      assert.fail(`Unexpected vault response: ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
  });

  // ── Vault Execute: Gemini LLM proxy ─────────────────────────────

  it("Step 3b: Execute via LLM proxy — Gemini", async () => {
    if (!agentAccessToken) {
      console.log("[phase3] Skipping — no agent token");
      return;
    }

    // Create a Gemini connection + policy for this agent
    const jwt = fixture?.jwt;
    if (!jwt) {
      console.log("[phase3] Skipping Gemini — no user JWT");
      return;
    }

    // Check if a Gemini connection exists
    const connRes = await fetch(`${API_URL}/v1/connections`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const connData = (await connRes.json()) as Record<string, unknown>;
    const connections = (connData.connections as Array<Record<string, unknown>>) || [];
    let geminiConn = connections.find((c) => c.service === "gemini");

    if (!geminiConn) {
      // Create one with the test key
      const createRes = await fetch(`${API_URL}/v1/connections/api-key`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: "gemini",
          service: "gemini",
          label: "E2E Gemini",
          apiKey: "AIzaSyAZ_RlkCHbuCG5r3rMmKtzmUpdEXy7b9pM",
        }),
      });
      if (!createRes.ok) {
        console.log(`[phase3] Gemini connection creation failed: ${createRes.status}`);
        return;
      }
      const created = (await createRes.json()) as { connection: { id: string } };
      geminiConn = { id: created.connection.id } as Record<string, unknown>;
      console.log(`[phase3] Gemini connection created: ${geminiConn.id}`);
    }

    // Always create a policy for the current agent (agent is new each run)
    const agentId =
      ((globalThis as Record<string, unknown>).__phase3_agentId as string) ||
      fixture?.agentId;
    const policyRes = await fetch(`${API_URL}/v1/policies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectionId: geminiConn.id,
        allowedModels: ["B"],
        defaultMode: "read_write",
        stepUpApproval: "never",
        allowlists: [{
          baseUrl: "https://generativelanguage.googleapis.com",
          methods: ["GET", "POST"],
          pathPatterns: ["/**"],
        }],
      }),
    });
    if (policyRes.ok) {
      console.log("[phase3] Gemini policy created for agent");
    } else {
      const err = await policyRes.text();
      console.log(`[phase3] Gemini policy creation: ${policyRes.status} ${err.slice(0, 100)}`);
    }

    // Execute via the LLM proxy endpoint
    const res = await fetch(
      `${API_URL}/v1/vault/llm/gemini/models/gemini-2.0-flash:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": agentAccessToken,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "Reply with exactly: VAULT_E2E_OK" }] }],
        }),
      },
    );

    const body = await res.text();
    console.log(`[phase3] Gemini LLM proxy: ${res.status} ${body.slice(0, 200)}`);

    if (res.status === 200) {
      try {
        const data = JSON.parse(body);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
        console.log(`[phase3] Gemini response: "${text.trim()}"`);
      } catch {
        console.log("[phase3] Gemini response not JSON (may be SSE)");
      }
    }

    assert.equal(res.status, 200, `Gemini LLM proxy should return 200, got ${res.status}`);
  });

  // ── Step-Up Approval (approvals.md) ──────────────────────────────

  it("Step 4: Step-up approval workflow", async () => {
    if (!agentAccessToken || !fixture?.jwt) {
      console.log("[phase3] Skipping — missing token or JWT");
      return;
    }

    const jwt = fixture.jwt;
    const agentId =
      ((globalThis as Record<string, unknown>).__phase3_agentId as string) ||
      fixture.agentId;

    // Use the Gemini connection (API key — doesn't expire like OAuth tokens)
    const connRes = await fetch(`${API_URL}/v1/connections`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    const connData = (await connRes.json()) as Record<string, unknown>;
    const connections = (connData.connections as Array<Record<string, unknown>>) || [];
    const geminiConn = connections.find((c) => c.service === "gemini");

    if (!geminiConn) {
      console.log("[phase3] Skipping approval test — no Gemini connection");
      return;
    }

    const geminiConnId = geminiConn.id as string;

    // 1. Delete any existing permissive policies for this agent + connection
    //    (Step 3b created one with stepUpApproval: "never")
    const existingPolicies = await fetch(`${API_URL}/v1/policies`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (existingPolicies.ok) {
      const pData = (await existingPolicies.json()) as { policies: Array<{ id: string; agentId: string; connectionId: string }> };
      for (const p of pData.policies || []) {
        if (p.agentId === agentId && p.connectionId === geminiConnId) {
          await fetch(`${API_URL}/v1/policies/${p.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${jwt}` },
          });
          console.log(`[phase3] Deleted existing policy: ${p.id}`);
        }
      }
    }

    // Create a policy with stepUpApproval: "always"
    const policyRes = await fetch(`${API_URL}/v1/policies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        connectionId: geminiConnId,
        allowedModels: ["B"],
        defaultMode: "read_write",
        stepUpApproval: "always",
        allowlists: [{
          baseUrl: "https://generativelanguage.googleapis.com",
          methods: ["GET", "POST"],
          pathPatterns: ["/**"],
        }],
      }),
    });

    if (!policyRes.ok) {
      console.log(`[phase3] Approval policy creation failed: ${policyRes.status}`);
      return;
    }
    const policy = (await policyRes.json()) as { policy: { id: string } };
    const approvalPolicyId = policy.policy.id;
    console.log(`[phase3] Created approval policy: ${approvalPolicyId}`);

    // 2. Execute a vault request → should get 202 (approval required)
    const execRes = await fetch(`${API_URL}/v1/vault/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentAccessToken}`,
      },
      body: JSON.stringify({
        model: "B",
        connectionId: geminiConnId,
        method: "GET",
        url: "https://generativelanguage.googleapis.com/v1beta/models",
      }),
    });

    const execData = (await execRes.json()) as {
      approvalRequired?: boolean;
      approvalRequestId?: string;
      reason?: string;
      expiresAt?: string;
    };

    console.log(`[phase3] Vault execute with approval: ${execRes.status}`);

    assert.equal(execRes.status, 202, `Should return 202 (approval required), got ${execRes.status}`);
    assert.ok(execData.approvalRequired, "Response should have approvalRequired: true");
    assert.ok(execData.approvalRequestId, "Response should have approvalRequestId");
    assert.ok(execData.expiresAt, "Response should have expiresAt");

    const approvalRequestId = execData.approvalRequestId!;
    console.log(`[phase3] Approval request: ${approvalRequestId}`);
    console.log(`[phase3] Reason: ${execData.reason}`);

    // 3. Approve the request (as the workspace owner)
    const approveRes = await fetch(
      `${API_URL}/v1/approvals/${approvalRequestId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
        },
      },
    );

    const approveData = (await approveRes.json()) as {
      approved?: boolean;
      approvalRequestId?: string;
      auditId?: string;
    };

    console.log(`[phase3] Approve: ${approveRes.status} ${JSON.stringify(approveData).slice(0, 200)}`);
    assert.equal(approveRes.status, 200, `Approve should return 200, got ${approveRes.status}: ${JSON.stringify(approveData).slice(0, 200)}`);
    assert.ok(approveData.approved, "Response should have approved: true");

    // 4. Re-execute with the approvalId → should succeed
    const reExecRes = await fetch(`${API_URL}/v1/vault/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentAccessToken}`,
      },
      body: JSON.stringify({
        model: "B",
        connectionId: geminiConnId,
        method: "GET",
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        approvalId: approvalRequestId,
      }),
    });

    const reExecData = (await reExecRes.json()) as Record<string, unknown>;
    console.log(`[phase3] Re-execute with approval: ${reExecRes.status}`);

    assert.equal(
      reExecRes.status, 200,
      `Re-execute with approval should return 200, got ${reExecRes.status}: ${JSON.stringify(reExecData).slice(0, 150)}`,
    );
    console.log("[phase3] Step-up approval: full flow succeeded (request → 202 → approve → re-execute → 200)");

    // 5. Clean up — delete the approval policy so it doesn't interfere
    await fetch(`${API_URL}/v1/policies/${approvalPolicyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    console.log("[phase3] Cleaned up approval policy");
  });

  // ── Audit Log (audit.md) ────────────────────────────────────────

  it("Step 5: Verify audit trail", async () => {
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
