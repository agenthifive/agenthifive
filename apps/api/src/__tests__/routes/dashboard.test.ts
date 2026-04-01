import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Dashboard Routes Tests with Real Test Database
 *
 * Tests: GET /dashboard/summary — aggregate counts for connections, agents, events today.
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import {
  createTestWorkspace,
  createTestAgent,
  createTestConnection,
} from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { connections } from "../../db/schema/connections.js";
import { auditEvents } from "../../db/schema/audit-events.js";
import { eq } from "drizzle-orm";

// =============================================================================
// Test suite
// =============================================================================

describe("Dashboard Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  let testUserId: string;

  before(async () => {
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;
    testUserId = workspace.ownerId;

    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
    });

    testToken = await mockJwks.createTestJwt({
      sub: testUserId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["dashboard:read"],
      sid: "session-dashboard",
    });

    const { default: dashboardRoutes } = await import(
      "../../routes/dashboard.js"
    );
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(dashboardRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    // Clear workspace-related data before each test (workspace persists)
    await db.delete(auditEvents).execute();
    await db.delete(agents).where(eq(agents.workspaceId, testWorkspaceId));
    await db.delete(connections).where(eq(connections.workspaceId, testWorkspaceId));
  });

  // ===========================================================================
  // GET /api/dashboard/summary
  // ===========================================================================

  describe("GET /api/dashboard/summary", () => {
    it("returns zeros when workspace is empty", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connections, 0);
      assert.equal(body.agents, 0);
      assert.equal(body.eventsToday, 0);
    });

    it("counts agents in the workspace", async () => {
      // Create 2 agents
      const agent1 = createTestAgent(testWorkspaceId, { name: "Agent One" });
      const agent2 = createTestAgent(testWorkspaceId, { name: "Agent Two" });
      await db.insert(agents).values([
        { id: agent1.id, name: agent1.name, workspaceId: testWorkspaceId },
        { id: agent2.id, name: agent2.name, workspaceId: testWorkspaceId },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agents, 2);
    });

    it("counts connections in the workspace", async () => {
      // Create 3 connections
      for (let i = 0; i < 3; i++) {
        const conn = createTestConnection(testWorkspaceId, {
          label: `Connection ${i}`,
        });
        await db.insert(connections).values({
          id: conn.id,
          provider: conn.provider,
          service: conn.service,
          label: conn.label,
          status: conn.status,
          workspaceId: testWorkspaceId,
          encryptedTokens: conn.encryptedTokens,
          grantedScopes: conn.grantedScopes,
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().connections, 3);
    });

    it("counts only today's audit events", async () => {
      const agent = createTestAgent(testWorkspaceId);
      await db.insert(agents).values({
        id: agent.id,
        name: agent.name,
        workspaceId: testWorkspaceId,
      });

      // Insert 2 events from today
      await db.insert(auditEvents).values({
        auditId: randomUUID(),
        timestamp: new Date(),
        actor: testUserId,
        agentId: agent.id,
        action: "token_vended",
        decision: "allowed",
        metadata: {},
      });
      await db.insert(auditEvents).values({
        auditId: randomUUID(),
        timestamp: new Date(),
        actor: testUserId,
        agentId: agent.id,
        action: "execution_completed",
        decision: "allowed",
        metadata: {},
      });

      // Insert 1 event from yesterday (should NOT be counted)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      await db.insert(auditEvents).values({
        auditId: randomUUID(),
        timestamp: yesterday,
        actor: testUserId,
        agentId: agent.id,
        action: "token_vended",
        decision: "allowed",
        metadata: {},
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().eventsToday, 2, "Should only count today's events");
    });

    it("does not count resources from other workspaces", async () => {
      // Create another workspace with its own agent and connection
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
        workspaceId: otherWorkspace.id,
      });

      const otherConn = createTestConnection(otherWorkspace.id);
      await db.insert(connections).values({
        id: otherConn.id,
        provider: otherConn.provider,
        service: otherConn.service,
        label: otherConn.label,
        status: otherConn.status,
        workspaceId: otherWorkspace.id,
        encryptedTokens: otherConn.encryptedTokens,
        grantedScopes: otherConn.grantedScopes,
      });

      // Also create one agent in OUR workspace
      const ourAgent = createTestAgent(testWorkspaceId, {
        name: "Our Agent",
      });
      await db.insert(agents).values({
        id: ourAgent.id,
        name: ourAgent.name,
        workspaceId: testWorkspaceId,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.agents, 1, "Should only count our workspace's agents");
      assert.equal(body.connections, 0, "Should not count other workspace's connections");
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/dashboard/summary",
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
