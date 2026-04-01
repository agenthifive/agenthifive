import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Agent Permission Requests Routes Tests with Real Test Database
 *
 * Tests: list permission requests, delete permission request
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace, createTestAgent, createTestConnection, createTestAccessToken } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { agentAccessTokens } from "../../db/schema/agent-access-tokens.js";
import { connections } from "../../db/schema/connections.js";
import { policies } from "../../db/schema/policies.js";
import { agentPermissionRequests } from "../../db/schema/agent-permission-requests.js";
import { eq } from "drizzle-orm";

// =============================================================================
// Test suite
// =============================================================================

describe("Agent Permission Requests Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  let testAgentId: string;
  let agentToken: string;
  let testConnectionId: string;

  before(async () => {
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });

    testToken = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["agents:read", "agents:write"],
      sid: "session-789",
    });

    // Create test agent with access token
    testAgentId = randomUUID();
    const { token, hash: tokenHash } = createTestAccessToken();
    agentToken = token;

    await db.insert(agents).values({
      id: testAgentId,
      name: "Test Agent",
      description: "Test agent for permission requests",
      workspaceId: testWorkspaceId,
      status: "active",
    });

    await db.insert(agentAccessTokens).values({
      agentId: testAgentId,
      workspaceId: testWorkspaceId,
      tokenHash,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });

    // Create test connection (for policy dedup tests)
    const conn = createTestConnection(testWorkspaceId);
    testConnectionId = conn.id;
    await db.insert(connections).values({
      id: conn.id,
      provider: conn.provider,
      service: conn.service,
      workspaceId: testWorkspaceId,
      label: conn.label,
      status: conn.status,
      grantedScopes: conn.grantedScopes,
      metadata: conn.metadata,
      encryptedTokens: conn.encryptedTokens,
    });

    const { default: agentPermissionRequestsRoutes } = await import("../../routes/agent-permission-requests.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(agentPermissionRequestsRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[AGENT PERMISSION REQUESTS TEST] Setup complete: workspace=${testWorkspaceId}, agent=${testAgentId}`);
  });

  after(async () => {
    // Cleanup test data
    await db.delete(agentPermissionRequests).where(eq(agentPermissionRequests.workspaceId, testWorkspaceId));
    await db.delete(policies).where(eq(policies.agentId, testAgentId));
    await db.delete(agentAccessTokens).where(eq(agentAccessTokens.agentId, testAgentId));
    await db.delete(connections).where(eq(connections.id, testConnectionId));
    await db.delete(agents).where(eq(agents.workspaceId, testWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, testWorkspaceId));

    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    // Clean up permission requests
    await db.delete(agentPermissionRequests).execute();

    // Clean up agents (except the test agent)
    await db.delete(agents).where((t) => t.id !== testAgentId).execute();

    // Clean up workspaces (except the test workspace)
    await db.delete(workspaces).where((t) => t.id !== testWorkspaceId).execute();
  });

  // ===========================================================================
  // GET /api/agent-permission-requests
  // ===========================================================================

  describe("GET /api/agent-permission-requests", () => {
    it("returns empty array when no permission requests exist", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] Get empty list");
      const res = await app.inject({
        method: "GET",
        url: "/api/agent-permission-requests",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { requests } = res.json();
      assert.ok(Array.isArray(requests));
      assert.equal(requests.length, 0);
    });

    it("lists all permission requests for the workspace", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] List permission requests");

      // Insert test permission requests
      await db.insert(agentPermissionRequests).values([
        {
          id: randomUUID(),
          agentId: testAgentId,
          workspaceId: testWorkspaceId,
          actionTemplateId: "gmail-read",
          reason: "I can help you manage your inbox",
        },
        {
          id: randomUUID(),
          agentId: testAgentId,
          workspaceId: testWorkspaceId,
          actionTemplateId: "calendar-read",
          reason: "I can help you schedule meetings",
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/agent-permission-requests",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { requests } = res.json();
      assert.equal(requests.length, 2);

      // Verify both requests are present (order may vary)
      const actionTemplateIds = requests.map((r: any) => r.actionTemplateId);
      assert.ok(actionTemplateIds.includes("gmail-read"), "Should include gmail-read");
      assert.ok(actionTemplateIds.includes("calendar-read"), "Should include calendar-read");

      // Verify common fields on first request
      assert.ok(requests[0].id);
      assert.equal(requests[0].agentId, testAgentId);
      assert.equal(requests[0].agentName, "Test Agent");
      assert.ok(requests[0].requestedAt);
    });

    it("only returns requests for the current workspace", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] Workspace scoping");

      // Create another workspace with its own agent and permission request
      const otherWorkspace = createTestWorkspace({ name: "Other Workspace" });
      await db.insert(workspaces).values({
        id: otherWorkspace.id,
        name: otherWorkspace.name,
        ownerId: otherWorkspace.ownerId,
      });

      const otherAgent = createTestAgent(otherWorkspace.id, {
        name: "Other Agent",
      });
      await db.insert(agents).values({
        id: otherAgent.id,
        name: otherAgent.name,
        description: otherAgent.description,
        workspaceId: otherWorkspace.id,
      });

      await db.insert(agentPermissionRequests).values([
        {
          id: randomUUID(),
          agentId: testAgentId,
          workspaceId: testWorkspaceId,
          actionTemplateId: "gmail-read",
          reason: "My workspace request",
        },
        {
          id: randomUUID(),
          agentId: otherAgent.id,
          workspaceId: otherWorkspace.id,
          actionTemplateId: "calendar-read",
          reason: "Other workspace request",
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/agent-permission-requests",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { requests } = res.json();
      assert.equal(requests.length, 1, "Should only return requests from current workspace");
      assert.equal(requests[0].actionTemplateId, "gmail-read");
      assert.equal(requests[0].reason, "My workspace request");
    });
  });

  // ===========================================================================
  // DELETE /api/agent-permission-requests/:id
  // ===========================================================================

  describe("DELETE /api/agent-permission-requests/:id", () => {
    it("denies a permission request by ID", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] Delete permission request");

      const [request] = await db
        .insert(agentPermissionRequests)
        .values({
          id: randomUUID(),
          agentId: testAgentId,
          workspaceId: testWorkspaceId,
          actionTemplateId: "gmail-read",
          reason: "Test request",
        })
        .returning();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agent-permission-requests/${request!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { success: true });

      // Verify it was marked as denied (not deleted)
      const [updated] = await db
        .select()
        .from(agentPermissionRequests)
        .where(eq(agentPermissionRequests.id, request!.id));
      assert.equal(updated!.status, "denied");
      assert.ok(updated!.resolvedAt);
    });

    it("returns 404 when permission request not found", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] Delete non-existent request");

      const fakeId = "a0000000-0000-0000-0000-000000000000";
      const res = await app.inject({
        method: "DELETE",
        url: `/api/agent-permission-requests/${fakeId}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.json(), { error: "Permission request not found" });
    });

    it("returns 403 when trying to delete request from another workspace", async () => {
      console.log("[AGENT PERMISSION REQUESTS TEST] Delete from other workspace");

      // Create another workspace with its own agent and permission request
      const otherWorkspace = createTestWorkspace({ name: "Other Workspace" });
      await db.insert(workspaces).values({
        id: otherWorkspace.id,
        name: otherWorkspace.name,
        ownerId: otherWorkspace.ownerId,
      });

      const otherAgent = createTestAgent(otherWorkspace.id, {
        name: "Other Agent",
      });
      await db.insert(agents).values({
        id: otherAgent.id,
        name: otherAgent.name,
        description: otherAgent.description,
        workspaceId: otherWorkspace.id,
      });

      const [otherRequest] = await db
        .insert(agentPermissionRequests)
        .values({
          id: randomUUID(),
          agentId: otherAgent.id,
          workspaceId: otherWorkspace.id,
          actionTemplateId: "gmail-read",
          reason: "Other workspace request",
        })
        .returning();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agent-permission-requests/${otherRequest!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 403);
      assert.deepEqual(res.json(), { error: "Forbidden" });

      // Verify it was NOT deleted
      const stillExists = await db
        .select()
        .from(agentPermissionRequests)
        .where((t) => t.id === otherRequest!.id);
      assert.equal(stillExists.length, 1, "Request should still exist");
    });
  });

  // ===========================================================================
  // POST /api/agent-permission-requests
  // ===========================================================================

  describe("POST /api/agent-permission-requests", () => {
    it("creates a permission request (happy path)", async () => {
      // Clean pending requests first
      await db.delete(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, testAgentId));

      const res = await app.inject({
        method: "POST",
        url: "/api/agent-permission-requests",
        headers: { "x-api-key": agentToken },
        payload: {
          actionTemplateId: "gmail-read",
          reason: "I need to read emails for the user",
        },
      });

      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.ok(body.id, "Should return request ID");
      assert.equal(body.actionTemplateId, "gmail-read");
      assert.equal(body.reason, "I need to read emails for the user");
      assert.ok(body.createdAt, "Should return createdAt timestamp");
    });

    it("rejects invalid actionTemplateId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-permission-requests",
        headers: { "x-api-key": agentToken },
        payload: {
          actionTemplateId: "nonexistent-action",
          reason: "This should fail",
        },
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error.includes("Unknown action template"));
    });

    it("returns 409 for duplicate pending request", async () => {
      // Clean and create initial request
      await db.delete(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, testAgentId));
      await db.insert(agentPermissionRequests).values({
        agentId: testAgentId,
        workspaceId: testWorkspaceId,
        actionTemplateId: "calendar-read",
        reason: "First request",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agent-permission-requests",
        headers: { "x-api-key": agentToken },
        payload: {
          actionTemplateId: "calendar-read",
          reason: "Duplicate request",
        },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.ok(body.error.includes("pending request"));
    });

    it("returns 409 when agent already has an active policy for this action", async () => {
      // Clean requests, create a policy with actionTemplateId
      await db.delete(agentPermissionRequests).where(eq(agentPermissionRequests.agentId, testAgentId));

      await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        actionTemplateId: "drive-read",
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "risk_based",
        allowlists: [],
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agent-permission-requests",
        headers: { "x-api-key": agentToken },
        payload: {
          actionTemplateId: "drive-read",
          reason: "I already have access",
        },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.ok(body.error.includes("already has access"));

      // Clean up the policy
      await db.delete(policies).where(eq(policies.agentId, testAgentId));
    });

    it("rejects non-agent callers (user JWT)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agent-permission-requests",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          actionTemplateId: "gmail-read",
          reason: "User JWT should not work",
        },
      });

      // User JWT has scp: ["agents:read", "agents:write"] — no "capabilities:request"
      assert.equal(res.statusCode, 403);
    });
  });
});
