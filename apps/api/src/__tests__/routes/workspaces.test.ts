import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Workspaces Routes Tests with Real Test Database
 *
 * Tests: get current workspace, update workspace name (owner auth).
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";

// =============================================================================
// Test suite
// =============================================================================

describe("Workspace Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let ownerToken: string;
  let nonOwnerToken: string;
  let testWorkspaceId: string;
  let ownerId: string;

  before(async () => {
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;
    ownerId = workspace.ownerId;

    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });

    // Owner token — sub matches ownerId
    ownerToken = await mockJwks.createTestJwt({
      sub: ownerId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["workspaces:read", "workspaces:write"],
      sid: "session-owner",
    });

    // Non-owner token — different sub
    nonOwnerToken = await mockJwks.createTestJwt({
      sub: "non-owner-user",
      wid: testWorkspaceId,
      roles: ["member"],
      scp: ["workspaces:read", "workspaces:write"],
      sid: "session-member",
    });

    const { default: workspaceRoutes } = await import("../../routes/workspaces.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(workspaceRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[WORKSPACE TEST] Setup complete: workspace=${testWorkspaceId} owner=${ownerId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  // ===========================================================================
  // GET /api/workspaces/current
  // ===========================================================================

  describe("GET /api/workspaces/current", () => {
    it("returns the current workspace", async () => {
      console.log("[WORKSPACE TEST] Get current");
      const res = await app.inject({
        method: "GET",
        url: "/api/workspaces/current",
        headers: { authorization: `Bearer ${ownerToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.id, testWorkspaceId);
      assert.ok(body.name);
      assert.equal(body.ownerId, ownerId);
      assert.ok(body.createdAt);
    });

    it("requires authentication", async () => {
      console.log("[WORKSPACE TEST] Auth required for GET");
      const res = await app.inject({
        method: "GET",
        url: "/api/workspaces/current",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // PUT /api/workspaces/current
  // ===========================================================================

  describe("PUT /api/workspaces/current", () => {
    it("allows owner to update workspace name", async () => {
      console.log("[WORKSPACE TEST] Owner update");
      const res = await app.inject({
        method: "PUT",
        url: "/api/workspaces/current",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { name: "Updated Workspace" },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().name, "Updated Workspace");
    });

    it("returns 403 when non-owner tries to update", async () => {
      console.log("[WORKSPACE TEST] Non-owner forbidden");
      const res = await app.inject({
        method: "PUT",
        url: "/api/workspaces/current",
        headers: { authorization: `Bearer ${nonOwnerToken}` },
        payload: { name: "Hacked Name" },
      });

      assert.equal(res.statusCode, 403);
      assert.ok(res.json().error.includes("owner"));
    });

    it("returns 400 for empty name", async () => {
      console.log("[WORKSPACE TEST] Empty name");
      const res = await app.inject({
        method: "PUT",
        url: "/api/workspaces/current",
        headers: { authorization: `Bearer ${ownerToken}` },
        payload: { name: "" },
      });

      assert.equal(res.statusCode, 400);
    });

    it("requires authentication", async () => {
      console.log("[WORKSPACE TEST] Auth required for PUT");
      const res = await app.inject({
        method: "PUT",
        url: "/api/workspaces/current",
        payload: { name: "Test" },
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
