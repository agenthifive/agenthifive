import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Admin Routes Tests
 *
 * Tests superadmin-only endpoints: stats, users, workspaces, audit.
 * Verifies auth guards, self-protection, and session revocation on disable.
 */

import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { users, sessions } from "../../db/schema/users.js";

describe("Admin Routes", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;

  // Superadmin user + workspace
  let adminUserId: string;
  let adminWorkspaceId: string;
  let adminToken: string;

  // Regular user + workspace
  let regularUserId: string;
  let regularWorkspaceId: string;
  let regularToken: string;

  before(async () => {
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create admin user + workspace
    const adminWs = createTestWorkspace({ name: "Admin Workspace" });
    adminUserId = adminWs.ownerId;
    adminWorkspaceId = adminWs.id;

    await db.insert(users).values({
      id: adminUserId,
      email: "admin@test.com",
      name: "Admin",
      emailVerified: true,
      platformRole: "superadmin",
    });
    await db.insert(workspaces).values({
      id: adminWorkspaceId,
      name: adminWs.name,
      ownerId: adminUserId,
    });

    // Create regular user + workspace
    const regularWs = createTestWorkspace({ name: "Regular Workspace" });
    regularUserId = regularWs.ownerId;
    regularWorkspaceId = regularWs.id;

    await db.insert(users).values({
      id: regularUserId,
      email: "user@test.com",
      name: "Regular User",
      emailVerified: true,
      platformRole: "user",
    });
    await db.insert(workspaces).values({
      id: regularWorkspaceId,
      name: regularWs.name,
      ownerId: regularUserId,
    });

    // Create JWTs
    adminToken = await mockJwks.createTestJwt({
      sub: adminUserId,
      wid: adminWorkspaceId,
      roles: ["owner"],
      scp: ["*"],
      sid: "admin-session",
      platformRole: "superadmin",
    });

    regularToken = await mockJwks.createTestJwt({
      sub: regularUserId,
      wid: regularWorkspaceId,
      roles: ["owner"],
      scp: ["*"],
      sid: "user-session",
      platformRole: "user",
    });

    const { default: adminRoutes } = await import("../../routes/admin.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(adminRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    // Cleanup test data
    await sql`DELETE FROM t_workspaces WHERE id IN (${adminWorkspaceId}, ${regularWorkspaceId})`;
    await sql`DELETE FROM t_users WHERE id IN (${adminUserId}, ${regularUserId})`;
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  // ── Auth guard ─────────────────────────────────────────────────────

  describe("Auth guard", () => {
    it("returns 403 for non-superadmin on all endpoints", async () => {
      const endpoints = [
        { method: "GET" as const, url: "/api/admin/stats" },
        { method: "GET" as const, url: "/api/admin/users" },
        { method: "GET" as const, url: `/api/admin/users/${regularUserId}` },
        { method: "GET" as const, url: "/api/admin/workspaces" },
        { method: "GET" as const, url: "/api/admin/audit" },
      ];

      for (const ep of endpoints) {
        const res = await app.inject({
          method: ep.method,
          url: ep.url,
          headers: { authorization: `Bearer ${regularToken}` },
        });
        assert.equal(res.statusCode, 403, `${ep.method} ${ep.url} should be 403 for non-superadmin`);
      }
    });

    it("returns 401 without auth", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/stats",
      });
      assert.equal(res.statusCode, 401);
    });
  });

  // ── GET /admin/stats ───────────────────────────────────────────────

  describe("GET /admin/stats", () => {
    it("returns platform-wide counts", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/stats",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(typeof body.totalUsers, "number");
      assert.equal(typeof body.totalWorkspaces, "number");
      assert.equal(typeof body.totalAgents, "number");
      assert.equal(typeof body.totalConnections, "number");
      assert.equal(typeof body.recentAuditCount, "number");
      // We have at least 2 users (admin + regular)
      assert.ok(body.totalUsers >= 2);
    });
  });

  // ── GET /admin/users ───────────────────────────────────────────────

  describe("GET /admin/users", () => {
    it("returns all users", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.users.length >= 2);
      assert.ok(body.total >= 2);

      // Check user shape
      const user = body.users[0];
      assert.ok(user.id);
      assert.ok(user.email);
      assert.ok(user.platformRole);
    });

    it("supports search", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users?search=admin%40test",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.users.length, 1);
      assert.equal(body.users[0].email, "admin@test.com");
    });
  });

  // ── GET /admin/users/:id ───────────────────────────────────────────

  describe("GET /admin/users/:id", () => {
    it("returns user detail", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/users/${regularUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.email, "user@test.com");
      assert.equal(body.platformRole, "user");
      assert.equal(body.workspaceId, regularWorkspaceId);
      assert.equal(typeof body.agentCount, "number");
    });

    it("returns 404 for non-existent user", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/users/a0000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("never returns password or encrypted tokens", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/users/${regularUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const raw = res.body;
      assert.ok(!raw.includes("password"));
      assert.ok(!raw.includes("encryptedTokens"));
      assert.ok(!raw.includes("accessToken"));
      assert.ok(!raw.includes("refreshToken"));
    });
  });

  // ── PATCH /admin/users/:id/role ────────────────────────────────────

  describe("PATCH /admin/users/:id/role", () => {
    it("promotes user to superadmin", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${regularUserId}/role`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { platformRole: "superadmin" },
      });

      assert.equal(res.statusCode, 200);

      // Verify in DB
      const [row] = await sql`SELECT platform_role FROM t_users WHERE id = ${regularUserId}`;
      assert.equal(row.platform_role, "superadmin");

      // Restore
      await sql`UPDATE t_users SET platform_role = 'user' WHERE id = ${regularUserId}`;
    });

    it("rejects self-role-change", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/admin/users/${adminUserId}/role`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { platformRole: "user" },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /own role/i);
    });
  });

  // ── POST /admin/users/:id/disable + enable ────────────────────────

  describe("Disable/Enable", () => {
    it("disables user and deletes sessions", async () => {
      // Insert a fake session
      await db.insert(sessions).values({
        userId: regularUserId,
        token: "fake-session-token-for-disable-test",
        expiresAt: new Date(Date.now() + 86400_000),
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${regularUserId}/disable`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);

      // Verify disabled_at set
      const [row] = await sql`SELECT disabled_at FROM t_users WHERE id = ${regularUserId}`;
      assert.ok(row.disabled_at);

      // Verify sessions deleted
      const sessionRows = await sql`SELECT id FROM t_sessions WHERE user_id = ${regularUserId}`;
      assert.equal(sessionRows.length, 0);
    });

    it("enables previously disabled user", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${regularUserId}/enable`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);

      const [row] = await sql`SELECT disabled_at FROM t_users WHERE id = ${regularUserId}`;
      assert.equal(row.disabled_at, null);
    });

    it("rejects self-disable", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/admin/users/${adminUserId}/disable`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /own account/i);
    });
  });

  // ── GET /admin/workspaces ──────────────────────────────────────────

  describe("GET /admin/workspaces", () => {
    it("returns all workspaces with owner info", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/workspaces",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.workspaces.length >= 2);
      assert.ok(body.total >= 2);

      const ws = body.workspaces.find((w: Record<string, unknown>) => w.id === regularWorkspaceId);
      assert.ok(ws);
      assert.equal(ws.ownerEmail, "user@test.com");
    });
  });

  // ── GET /admin/workspaces/:id ──────────────────────────────────────

  describe("GET /admin/workspaces/:id", () => {
    it("returns workspace detail with agents and connections", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/admin/workspaces/${adminWorkspaceId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.id, adminWorkspaceId);
      assert.ok(Array.isArray(body.agents));
      assert.ok(Array.isArray(body.connections));
    });

    it("returns 404 for non-existent workspace", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/workspaces/a0000000-0000-0000-0000-000000000000",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ── GET /admin/audit ───────────────────────────────────────────────

  describe("GET /admin/audit", () => {
    it("returns cross-workspace audit events", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/admin/audit",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.events));
      assert.ok("nextCursor" in body);
    });
  });

  // ── DELETE /admin/users/:id ────────────────────────────────────────

  describe("DELETE /admin/users/:id", () => {
    it("rejects self-deletion", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/admin/users/${adminUserId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /own account/i);
    });
  });
});
