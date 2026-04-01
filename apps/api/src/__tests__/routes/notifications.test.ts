import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

/**
 * Notifications Routes Tests
 *
 * Tests:
 * - GET /notifications — list notifications
 * - GET /notifications/unread-count — unread count
 * - POST /notifications/:id/read — mark one as read
 * - POST /notifications/read-all — mark all as read
 * - Workspace scoping (can't see other workspace's notifications)
 */

// =============================================================================
// STEP 0: Environment variables BEFORE any imports
// =============================================================================
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// =============================================================================
// STEP 1: Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { notifications } from "../../db/schema/notifications.js";

// =============================================================================
// STEP 2: Test suite
// =============================================================================

describe("Notifications Routes", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testWorkspaceId: string;
  let otherWorkspaceId: string;
  let testToken: string;
  let notifId1: string;
  let notifId2: string;

  before(async () => {
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create two workspaces
    const ws = createTestWorkspace();
    testWorkspaceId = ws.id;
    await db.insert(workspaces).values({
      id: ws.id, name: ws.name, ownerId: ws.ownerId,
      createdAt: ws.createdAt, updatedAt: ws.updatedAt,
    });

    const otherWs = createTestWorkspace({ name: "Other Workspace" });
    otherWorkspaceId = otherWs.id;
    await db.insert(workspaces).values({
      id: otherWs.id, name: otherWs.name, ownerId: otherWs.ownerId,
      createdAt: otherWs.createdAt, updatedAt: otherWs.updatedAt,
    });

    // Insert test notifications
    const [n1] = await db.insert(notifications).values({
      workspaceId: testWorkspaceId,
      type: "permission_request",
      title: "Agent requests access",
      body: "Agent wants to read emails",
      linkUrl: "/dashboard/approvals",
    }).returning({ id: notifications.id });
    notifId1 = n1!.id;

    const [n2] = await db.insert(notifications).values({
      workspaceId: testWorkspaceId,
      type: "connection_issue",
      title: "Connection needs reauth",
      body: "Gmail token expired",
    }).returning({ id: notifications.id });
    notifId2 = n2!.id;

    // Insert notification for other workspace (should not be visible)
    await db.insert(notifications).values({
      workspaceId: otherWorkspaceId,
      type: "permission_request",
      title: "Other workspace notification",
      body: "Should not be visible",
    });

    testToken = await mockJwks.createTestJwt({
      sub: ws.ownerId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["*"],
      sid: randomUUID(),
    });

    const { default: notificationRoutes } = await import("../../routes/notifications.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(notificationRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    await db.delete(notifications).where(eq(notifications.workspaceId, testWorkspaceId));
    await db.delete(notifications).where(eq(notifications.workspaceId, otherWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, testWorkspaceId));
    await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));

    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
    delete process.env.ENCRYPTION_KEY;
  });

  // ─── GET /notifications ─────────────────────────────────────────

  describe("GET /notifications", () => {
    it("returns notifications for current workspace only", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/notifications",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { notifications: Array<{ id: string; type: string }> };
      assert.ok(Array.isArray(body.notifications));
      assert.equal(body.notifications.length, 2);

      // Should not contain other workspace's notification
      assert.ok(body.notifications.every((n) => n.id === notifId1 || n.id === notifId2));
    });

    it("filters by unreadOnly", async () => {
      // Mark one as read first
      await db.update(notifications).set({ read: true }).where(eq(notifications.id, notifId1));

      const res = await app.inject({
        method: "GET",
        url: "/api/notifications?unreadOnly=true",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { notifications: Array<{ id: string }> };
      assert.equal(body.notifications.length, 1);
      assert.equal(body.notifications[0]!.id, notifId2);

      // Reset
      await db.update(notifications).set({ read: false }).where(eq(notifications.id, notifId1));
    });
  });

  // ─── GET /notifications/unread-count ────────────────────────────

  describe("GET /notifications/unread-count", () => {
    it("returns correct unread count", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/notifications/unread-count",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { count: number };
      assert.equal(body.count, 2);
    });
  });

  // ─── POST /notifications/:id/read ──────────────────────────────

  describe("POST /notifications/:id/read", () => {
    it("marks a notification as read", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/notifications/${notifId1}/read`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { success: boolean };
      assert.equal(body.success, true);

      // Verify unread count decreased
      const countRes = await app.inject({
        method: "GET",
        url: "/api/notifications/unread-count",
        headers: { authorization: `Bearer ${testToken}` },
      });
      const countBody = JSON.parse(countRes.payload) as { count: number };
      assert.equal(countBody.count, 1);

      // Reset
      await db.update(notifications).set({ read: false }).where(eq(notifications.id, notifId1));
    });

    it("returns 404 for non-existent notification", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/notifications/${randomUUID()}/read`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ─── POST /notifications/read-all ──────────────────────────────

  describe("POST /notifications/read-all", () => {
    it("marks all notifications as read", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/notifications/read-all",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { updated: number };
      assert.equal(body.updated, 2);

      // Verify unread count is 0
      const countRes = await app.inject({
        method: "GET",
        url: "/api/notifications/unread-count",
        headers: { authorization: `Bearer ${testToken}` },
      });
      const countBody = JSON.parse(countRes.payload) as { count: number };
      assert.equal(countBody.count, 0);

      // Reset
      await db.update(notifications).set({ read: false }).where(eq(notifications.workspaceId, testWorkspaceId));
    });
  });
});
