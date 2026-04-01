import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Activity Routes Tests with Real Test Database
 *
 * Tests: enriched activity feed, workspace scoping, filters, pagination.
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

// =============================================================================
// Test suite
// =============================================================================

describe("Activity Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  let testAgentId: string;
  let testConnectionId: string;
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

    const agent = createTestAgent(testWorkspaceId, {
      name: "Activity Test Agent",
    });
    testAgentId = agent.id;
    await db.insert(agents).values({
      id: agent.id,
      name: agent.name,
      workspaceId: testWorkspaceId,
    });

    const connection = createTestConnection(testWorkspaceId, {
      label: "Activity Gmail",
      provider: "google",
    });
    testConnectionId = connection.id;
    await db.insert(connections).values({
      id: connection.id,
      provider: connection.provider,
      service: connection.service,
      label: connection.label,
      status: connection.status,
      workspaceId: testWorkspaceId,
      encryptedTokens: connection.encryptedTokens,
      grantedScopes: connection.grantedScopes,
    });

    testToken = await mockJwks.createTestJwt({
      sub: testUserId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["activity:read"],
      sid: "session-activity",
    });

    const { default: activityRoutes } = await import(
      "../../routes/activity.js"
    );
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(activityRoutes, { prefix: "/api" });
    await app.ready();

    console.log("[ACTIVITY TEST] Setup complete");
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    await db.delete(auditEvents).execute();
  });

  /** Helper to insert an audit event */
  async function insertEvent(
    overrides: Partial<{
      auditId: string;
      timestamp: Date;
      actor: string;
      agentId: string | null;
      connectionId: string | null;
      action: string;
      decision: "allowed" | "denied" | "error";
      metadata: Record<string, unknown>;
    }> = {},
  ) {
    const [row] = await db
      .insert(auditEvents)
      .values({
        auditId: overrides.auditId ?? randomUUID(),
        timestamp: overrides.timestamp ?? new Date(),
        actor: overrides.actor ?? testUserId,
        agentId:
          overrides.agentId !== undefined ? overrides.agentId : testAgentId,
        connectionId:
          overrides.connectionId !== undefined
            ? overrides.connectionId
            : testConnectionId,
        action: overrides.action ?? "token_vended",
        decision: (overrides.decision ?? "allowed") as
          | "allowed"
          | "denied"
          | "error",
        metadata: overrides.metadata ?? {},
      })
      .returning();
    return row!;
  }

  // ===========================================================================
  // GET /api/activity
  // ===========================================================================

  describe("GET /api/activity", () => {
    it("returns enriched events with agentName and connection details", async () => {
      console.log("[ACTIVITY TEST] Enriched events");
      await insertEvent({
        agentId: testAgentId,
        connectionId: testConnectionId,
        action: "token_vended",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/activity",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.events));
      assert.equal(body.events.length, 1);

      const event = body.events[0];
      assert.equal(event.agentName, "Activity Test Agent");
      assert.equal(event.connectionLabel, "Activity Gmail");
      assert.equal(event.connectionProvider, "google");
      assert.equal(event.action, "token_vended");
    });

    it("returns null enrichment for events without agent/connection", async () => {
      console.log("[ACTIVITY TEST] Null enrichment");
      await insertEvent({
        agentId: null,
        connectionId: null,
        action: "manual_action",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/activity",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const event = res.json().events[0];
      assert.equal(event.agentName, null);
      assert.equal(event.connectionLabel, null);
      assert.equal(event.connectionProvider, null);
    });

    it("returns filters object with workspace agents and connections", async () => {
      console.log("[ACTIVITY TEST] Filters object");
      const res = await app.inject({
        method: "GET",
        url: "/api/activity",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { filters } = res.json();
      assert.ok(filters);

      // Agents filter
      assert.ok(Array.isArray(filters.agents));
      const agentFilter = filters.agents.find(
        (a: { id: string }) => a.id === testAgentId,
      );
      assert.ok(agentFilter, "Should contain test agent");
      assert.equal(agentFilter.name, "Activity Test Agent");

      // Connections filter
      assert.ok(Array.isArray(filters.connections));
      const connFilter = filters.connections.find(
        (c: { id: string }) => c.id === testConnectionId,
      );
      assert.ok(connFilter, "Should contain test connection");
      assert.equal(connFilter.label, "Activity Gmail");
      assert.equal(connFilter.provider, "google");
    });

    it("filters by agentId", async () => {
      console.log("[ACTIVITY TEST] Filter by agentId");
      await insertEvent({ agentId: testAgentId, action: "with_agent" });
      await insertEvent({ agentId: null, action: "without_agent" });

      const res = await app.inject({
        method: "GET",
        url: `/api/activity?agentId=${testAgentId}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].agentId, testAgentId);
    });

    it("returns empty for connectionId not in workspace", async () => {
      console.log("[ACTIVITY TEST] Foreign connectionId");
      await insertEvent();

      const res = await app.inject({
        method: "GET",
        url: `/api/activity?connectionId=${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().events, []);
      assert.equal(res.json().nextCursor, null);
    });

    it("supports cursor-based pagination", async () => {
      console.log("[ACTIVITY TEST] Cursor pagination");
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await insertEvent({
          timestamp: new Date(now - i * 1000),
          action: `action_${i}`,
        });
      }

      // First page: limit=2
      const res1 = await app.inject({
        method: "GET",
        url: "/api/activity?limit=2",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res1.statusCode, 200);
      const page1 = res1.json();
      assert.equal(page1.events.length, 2);
      assert.ok(page1.nextCursor, "Should have nextCursor");

      // Second page
      const res2 = await app.inject({
        method: "GET",
        url: `/api/activity?limit=2&cursor=${page1.nextCursor}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res2.statusCode, 200);
      const page2 = res2.json();
      assert.equal(page2.events.length, 1);
      assert.equal(page2.nextCursor, null, "Last page should have null cursor");
    });

    it("requires authentication", async () => {
      console.log("[ACTIVITY TEST] Auth required");
      const res = await app.inject({
        method: "GET",
        url: "/api/activity",
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
