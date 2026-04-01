import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Audit Routes Tests with Real Test Database
 *
 * Tests: paginated audit events, cursor pagination, filtering, JSON/CSV export.
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

describe("Audit Routes (Database Integrated)", () => {
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

    const agent = createTestAgent(testWorkspaceId, { name: "Audit Test Agent" });
    testAgentId = agent.id;
    await db.insert(agents).values({
      id: agent.id,
      name: agent.name,
      workspaceId: testWorkspaceId,
    });

    const connection = createTestConnection(testWorkspaceId, {
      label: "Audit Test Connection",
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
      scp: ["audit:read"],
      sid: "session-audit",
    });

    const { default: auditRoutes } = await import("../../routes/audit.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(auditRoutes, { prefix: "/api" });
    await app.ready();

    console.log("[AUDIT TEST] Setup complete");
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    await db.delete(auditEvents).execute();
  });

  /** Helper to insert an audit event with sensible defaults */
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
        agentId: overrides.agentId !== undefined ? overrides.agentId : testAgentId,
        connectionId:
          overrides.connectionId !== undefined
            ? overrides.connectionId
            : testConnectionId,
        action: overrides.action ?? "token_vended",
        decision: (overrides.decision ?? "allowed") as "allowed" | "denied" | "error",
        metadata: overrides.metadata ?? {},
      })
      .returning();
    return row!;
  }

  // ===========================================================================
  // GET /api/audit
  // ===========================================================================

  describe("GET /api/audit", () => {
    it("returns paginated audit events", async () => {
      console.log("[AUDIT TEST] Paginated list");
      await insertEvent({ action: "token_vended" });
      await insertEvent({ action: "execution_completed" });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.events));
      assert.equal(body.events.length, 2);
      assert.ok(body.events[0].auditId);
      assert.ok(body.events[0].timestamp);
      assert.ok(body.events[0].action);
      assert.ok(body.events[0].decision);
    });

    it("supports cursor-based pagination", async () => {
      console.log("[AUDIT TEST] Cursor pagination");
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
        url: "/api/audit?limit=2",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res1.statusCode, 200);
      const page1 = res1.json();
      assert.equal(page1.events.length, 2);
      assert.ok(page1.nextCursor, "Should have nextCursor for more results");

      // Second page using cursor
      const res2 = await app.inject({
        method: "GET",
        url: `/api/audit?limit=2&cursor=${page1.nextCursor}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res2.statusCode, 200);
      const page2 = res2.json();
      assert.equal(page2.events.length, 1);
      assert.equal(page2.nextCursor, null, "Last page should have null cursor");

      // All 3 unique auditIds across both pages
      const allIds = [...page1.events, ...page2.events].map(
        (e: { auditId: string }) => e.auditId,
      );
      assert.equal(new Set(allIds).size, 3, "Should have 3 unique events");
    });

    it("filters by agentId", async () => {
      console.log("[AUDIT TEST] Filter by agentId");
      await insertEvent({ agentId: testAgentId, action: "token_vended" });
      await insertEvent({ agentId: null, action: "other_action" });

      const res = await app.inject({
        method: "GET",
        url: `/api/audit?agentId=${testAgentId}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].agentId, testAgentId);
    });

    it("filters by connectionId", async () => {
      console.log("[AUDIT TEST] Filter by connectionId");
      await insertEvent({ connectionId: testConnectionId });
      await insertEvent({ connectionId: null });

      const res = await app.inject({
        method: "GET",
        url: `/api/audit?connectionId=${testConnectionId}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].connectionId, testConnectionId);
    });

    it("filters by action", async () => {
      console.log("[AUDIT TEST] Filter by action");
      await insertEvent({ action: "token_vended" });
      await insertEvent({ action: "execution_completed" });
      await insertEvent({ action: "token_vended" });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit?action=execution_completed",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].action, "execution_completed");
    });

    it("filters by date range", async () => {
      console.log("[AUDIT TEST] Filter by date range");
      const past = new Date("2024-01-01T00:00:00Z");
      const recent = new Date("2025-06-01T00:00:00Z");

      await insertEvent({ timestamp: past, action: "old_event" });
      await insertEvent({ timestamp: recent, action: "recent_event" });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit?dateFrom=2025-01-01T00:00:00Z",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].action, "recent_event");
    });

    it("returns empty for agentId not in workspace", async () => {
      console.log("[AUDIT TEST] Foreign agentId");
      await insertEvent();

      const res = await app.inject({
        method: "GET",
        url: `/api/audit?agentId=${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().events, []);
      assert.equal(res.json().nextCursor, null);
    });

    it("requires authentication", async () => {
      console.log("[AUDIT TEST] Auth required");
      const res = await app.inject({
        method: "GET",
        url: "/api/audit",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // GET /api/audit/export
  // ===========================================================================

  describe("GET /api/audit/export", () => {
    it("exports as JSON", async () => {
      console.log("[AUDIT TEST] JSON export");
      await insertEvent({ action: "token_vended" });
      await insertEvent({ action: "execution_completed" });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit/export?format=json",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(
        res.headers["content-type"]?.toString().includes("application/json"),
      );
      assert.ok(
        res.headers["content-disposition"]
          ?.toString()
          .includes("audit-export.json"),
      );
      const data = res.json();
      assert.ok(Array.isArray(data));
      assert.equal(data.length, 2);
      assert.ok(data[0].auditId);
      assert.ok(data[0].action);
    });

    it("exports as CSV with proper formatting", async () => {
      console.log("[AUDIT TEST] CSV export");
      await insertEvent({
        action: "token_vended",
        metadata: { provider: "google", scope: "gmail" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit/export?format=csv",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.ok(res.headers["content-type"]?.toString().includes("text/csv"));
      assert.ok(
        res.headers["content-disposition"]
          ?.toString()
          .includes("audit-export.csv"),
      );

      const csv = res.body;
      const lines = csv.split("\n");
      assert.equal(
        lines[0],
        "audit_id,timestamp,actor,agent_id,connection_id,action,decision,metadata",
      );
      assert.ok(lines.length >= 2, "Should have header + data row(s)");
      assert.ok(lines[1]!.includes("token_vended"));
      // Metadata should be CSV-escaped (double-quoted JSON)
      assert.ok(lines[1]!.includes("google"), "Metadata should contain provider");
    });

    it("applies filters in export", async () => {
      console.log("[AUDIT TEST] Filtered export");
      await insertEvent({ action: "token_vended" });
      await insertEvent({ action: "execution_completed" });

      const res = await app.inject({
        method: "GET",
        url: "/api/audit/export?format=json&action=token_vended",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const data = res.json();
      assert.equal(data.length, 1);
      assert.equal(data[0].action, "token_vended");
    });

    it("returns empty CSV for agentId not in workspace", async () => {
      console.log("[AUDIT TEST] Empty CSV for foreign agentId");
      await insertEvent();

      const res = await app.inject({
        method: "GET",
        url: `/api/audit/export?format=csv&agentId=${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const csv = res.body;
      assert.ok(csv.startsWith("audit_id,timestamp"));
      const lines = csv.trim().split("\n");
      assert.equal(lines.length, 1, "Only header row for empty result");
    });

    it("requires authentication", async () => {
      console.log("[AUDIT TEST] Auth required for export");
      const res = await app.inject({
        method: "GET",
        url: "/api/audit/export",
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
