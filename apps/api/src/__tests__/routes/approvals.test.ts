import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Approvals Routes Tests with Real Test Database
 *
 * Tests the step-up approval workflow: list, approve, deny.
 * Mocks undici + oauth-connectors to prevent real network calls
 * during the approve+execute path.
 *
 * Setup: pnpm test:db:up
 * Run: DATABASE_URL=postgresql://test:test_password@localhost:5433/agenthifive_test pnpm test
 */

// =============================================================================
// STEP 0: Environment variables BEFORE any imports
// =============================================================================
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// =============================================================================
// STEP 1: Mock external dependencies (BEFORE route imports)
// =============================================================================

// No undici or oauth-connector mocks needed — approve endpoint no longer executes requests

// =============================================================================
// STEP 2: Imports (AFTER mocking)
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace, createTestConnection } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { connections } from "../../db/schema/connections.js";
import { policies } from "../../db/schema/policies.js";
import { approvalRequests } from "../../db/schema/approval-requests.js";
import { encrypt } from "@agenthifive/security";
import { eq } from "drizzle-orm";

// =============================================================================
// STEP 3: Test suite
// =============================================================================

describe("Approval Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  let testAgentId: string;
  let testConnectionId: string;
  let testPolicyId: string;
  let encryptedTokens: string;

  before(async () => {
    // Warm up pool
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create workspace
    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });

    // Create agent
    testAgentId = randomUUID();
    await db.insert(agents).values({
      id: testAgentId,
      name: "Test Agent",
      description: "Agent for approval tests",
      workspaceId: testWorkspaceId,
    });

    // Create connection with encrypted tokens
    const key = process.env.ENCRYPTION_KEY!;
    encryptedTokens = JSON.stringify(
      encrypt(
        JSON.stringify({
          accessToken: "old_access_token",
          refreshToken: "test_refresh_token",
          expiresAt: Math.floor(Date.now() / 1000) - 3600, // expired, will refresh
        }),
        key,
      ),
    );

    const conn = createTestConnection(testWorkspaceId);
    testConnectionId = conn.id;
    await db.insert(connections).values({
      id: conn.id,
      provider: "google",
      service: "google-gmail",
      workspaceId: testWorkspaceId,
      label: "Test Gmail",
      status: "healthy",
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      metadata: {},
      encryptedTokens,
    });

    // Create policy
    testPolicyId = randomUUID();
    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO t_policies (id, agent_id, connection_id, allowed_models, default_mode, step_up_approval, allowlists, rate_limits, time_windows)
        VALUES (${testPolicyId}, ${testAgentId}, ${testConnectionId},
                ${sql.array(["A", "B"])}, 'read_write', 'risk_based',
                ${JSON.stringify([{ baseUrl: "https://www.googleapis.com", methods: ["GET", "POST"], pathPatterns: ["/gmail/v1/users/me/messages/*"] }])}::jsonb,
                null, '[]'::jsonb)
      `;
    });

    // Create JWT
    testToken = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["approvals:read", "approvals:write"],
      sid: "session-789",
    });

    // Import and register routes
    const { default: approvalRoutes } = await import("../../routes/approvals.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(approvalRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[APPROVAL TEST] Setup complete: workspace=${testWorkspaceId} policy=${testPolicyId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    // Clear approval requests before each test
    await db.delete(approvalRequests).execute();
  });

  // Helper to insert an approval request
  async function insertApproval(overrides: {
    id?: string;
    status?: string;
    expiresAt?: Date;
    requestDetails?: Record<string, unknown>;
  } = {}) {
    const id = overrides.id ?? randomUUID();
    const expiresAt = overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000); // 5 min from now
    const status = overrides.status ?? "pending";
    const requestDetails = overrides.requestDetails ?? {
      method: "GET",
      url: "https://www.googleapis.com/gmail/v1/users/me/messages/123",
      query: null,
      headers: null,
      body: null,
    };

    await sql`
      INSERT INTO t_approval_requests (id, policy_id, agent_id, connection_id, workspace_id, actor, status, request_details, expires_at)
      VALUES (${id}, ${testPolicyId}, ${testAgentId}, ${testConnectionId}, ${testWorkspaceId}, 'user-123', ${status}, ${JSON.stringify(requestDetails)}::jsonb, ${expiresAt.toISOString()}::timestamptz)
    `;

    return { id, status, expiresAt, requestDetails };
  }

  // ===========================================================================
  // GET /api/approvals — List approval requests
  // ===========================================================================

  describe("GET /api/approvals", () => {
    it("returns enriched approval requests", async () => {
      console.log("[APPROVAL TEST] List approvals");
      const approval = await insertApproval();

      const res = await app.inject({
        method: "GET",
        url: "/api/approvals",
        headers: { authorization: `Bearer ${testToken}` },
      });

      console.log(`[APPROVAL TEST] List response: ${res.statusCode}`, JSON.stringify(res.json(), null, 2));
      assert.equal(res.statusCode, 200);
      const { approvals } = res.json();
      assert.ok(Array.isArray(approvals));
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].id, approval.id);
      assert.equal(approvals[0].status, "pending");
      // Enrichment fields
      assert.equal(approvals[0].agentName, "Test Agent");
      assert.equal(approvals[0].connectionLabel, "Test Gmail");
      assert.equal(approvals[0].connectionProvider, "google");
    });

    it("returns empty array when no approvals", async () => {
      console.log("[APPROVAL TEST] Empty list");
      const res = await app.inject({
        method: "GET",
        url: "/api/approvals",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().approvals, []);
    });

    it("marks expired pending approvals in response", async () => {
      console.log("[APPROVAL TEST] Expired in list");
      await insertApproval({
        expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/approvals",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      // The expired row is in the response as "expired"
      const { approvals } = res.json();
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].status, "expired");
    });

    it("requires authentication", async () => {
      console.log("[APPROVAL TEST] Auth required for GET");
      const res = await app.inject({
        method: "GET",
        url: "/api/approvals",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // POST /api/approvals/:id/approve
  // ===========================================================================

  describe("POST /api/approvals/:id/approve", () => {
    it("returns 404 when approval not found", async () => {
      console.log("[APPROVAL TEST] Approve 404");
      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${randomUUID()}/approve`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.ok(res.json().error.includes("not found"));
    });

    it("returns 409 when approval is already approved", async () => {
      console.log("[APPROVAL TEST] Already approved");
      const approval = await insertApproval({ status: "approved" });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/approve`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
      assert.ok(res.json().error.includes("already approved"));
    });

    it("returns 409 when approval is already denied", async () => {
      console.log("[APPROVAL TEST] Already denied");
      const approval = await insertApproval({ status: "denied" });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/approve`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
      assert.ok(res.json().error.includes("already denied"));
    });

    it("returns 410 when approval has expired", async () => {
      console.log("[APPROVAL TEST] Expired approve");
      const approval = await insertApproval({
        expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/approve`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 410);
      assert.ok(res.json().error.includes("expired"));
    });

    // Connection status checks (revoked, needs_reauth) are NOT done at approve time —
    // they're checked when the agent re-submits via vault/execute with the approvalId.

    it("marks approval as approved without executing", async () => {
      console.log("[APPROVAL TEST] Approve (mark only)");
      const approval = await insertApproval({
        requestDetails: {
          method: "GET",
          url: "https://www.googleapis.com/gmail/v1/users/me/messages/123",
          query: null,
          headers: null,
          body: null,
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/approve`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      console.log(`[APPROVAL TEST] Approve response: ${res.statusCode}`, res.json());
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.approved, true);
      assert.equal(body.approvalRequestId, approval.id);
      assert.ok(body.auditId);

      // Verify approval was marked as approved in DB
      const [updated] = await db.select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approval.id));
      assert.equal(updated!.status, "approved");
    });

    it("requires authentication", async () => {
      console.log("[APPROVAL TEST] Auth required for approve");
      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${randomUUID()}/approve`,
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // POST /api/approvals/:id/deny
  // ===========================================================================

  describe("POST /api/approvals/:id/deny", () => {
    it("denies a pending approval", async () => {
      console.log("[APPROVAL TEST] Deny success");
      const approval = await insertApproval();

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/deny`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      console.log(`[APPROVAL TEST] Deny response: ${res.statusCode}`, res.json());
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.denied, true);
      assert.equal(body.approvalRequestId, approval.id);
      assert.ok(body.auditId);

      // Verify status in DB
      const [updated] = await db.select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approval.id));
      assert.equal(updated!.status, "denied");
    });

    it("returns 404 when approval not found", async () => {
      console.log("[APPROVAL TEST] Deny 404");
      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${randomUUID()}/deny`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 409 when approval is already denied", async () => {
      console.log("[APPROVAL TEST] Already denied - deny");
      const approval = await insertApproval({ status: "denied" });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/deny`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });

    it("returns 409 when approval is already approved", async () => {
      console.log("[APPROVAL TEST] Already approved - deny");
      const approval = await insertApproval({ status: "approved" });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/deny`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });

    it("returns 410 when approval has expired", async () => {
      console.log("[APPROVAL TEST] Expired deny");
      const approval = await insertApproval({
        expiresAt: new Date(Date.now() - 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${approval.id}/deny`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 410);
    });

    it("requires authentication", async () => {
      console.log("[APPROVAL TEST] Auth required for deny");
      const res = await app.inject({
        method: "POST",
        url: `/api/approvals/${randomUUID()}/deny`,
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // GET /api/approvals/:id — Get approval by ID
  // ===========================================================================

  describe("GET /api/approvals/:id", () => {
    it("returns approval with enriched fields", async () => {
      const approval = await insertApproval();

      const res = await app.inject({
        method: "GET",
        url: `/api/approvals/${approval.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.approval.id, approval.id);
      assert.equal(body.approval.status, "pending");
      assert.equal(body.approval.agentName, "Test Agent");
      assert.equal(body.approval.connectionLabel, "Test Gmail");
      assert.equal(body.approval.connectionProvider, "google");
      assert.ok(body.approval.requestDetails);
    });

    it("returns 404 for nonexistent approval", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/approvals/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("marks expired pending approval in response", async () => {
      const approval = await insertApproval({
        expiresAt: new Date(Date.now() - 60 * 1000), // expired 1 min ago
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/approvals/${approval.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().approval.status, "expired");
    });

    it("returns non-pending statuses as-is", async () => {
      const approval = await insertApproval({ status: "denied" });

      const res = await app.inject({
        method: "GET",
        url: `/api/approvals/${approval.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().approval.status, "denied");
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/approvals/${randomUUID()}`,
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
