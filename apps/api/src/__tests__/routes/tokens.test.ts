import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID, createHash } from "node:crypto";

/**
 * Tokens Routes Tests with Real Test Database
 *
 * Tests: create, list, revoke, rename (PUT).
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { eq, and, isNull } from "drizzle-orm";
import { workspaces } from "../../db/schema/workspaces.js";
import { users } from "../../db/schema/users.js";
import { personalAccessTokens } from "../../db/schema/personal-access-tokens.js";

// =============================================================================
// Test suite
// =============================================================================

describe("Token Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  const testUserId = "00000000-0000-0000-0000-000000000abc";

  before(async () => {
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create test user (PATs have FK to users)
    await db.insert(users).values({
      id: testUserId,
      email: "token-test@example.com",
      name: "Token Test User",
    }).onConflictDoNothing();

    // Create test workspace (delete any leftover from previous runs — owner_id is unique)
    await db.delete(workspaces).where(eq(workspaces.ownerId, testUserId));
    const workspace = createTestWorkspace({ ownerId: testUserId });
    testWorkspaceId = workspace.id;
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });

    testToken = await mockJwks.createTestJwt({
      sub: testUserId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["tokens:read", "tokens:write"],
      sid: "session-789",
    });

    const { default: tokenRoutes } = await import("../../routes/tokens.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(tokenRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[TOKEN TEST] Setup complete: workspace=${testWorkspaceId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    await db.delete(personalAccessTokens).execute();
  });

  // Helper to insert a PAT directly in DB
  async function insertToken(overrides: {
    name?: string;
    revokedAt?: Date | null;
  } = {}) {
    const id = randomUUID();
    const tokenHash = createHash("sha256").update(`ah5p_test_${id}`).digest("hex");
    const [row] = await db.insert(personalAccessTokens).values({
      id,
      userId: testUserId,
      workspaceId: testWorkspaceId,
      name: overrides.name ?? "Test Token",
      tokenHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      revokedAt: overrides.revokedAt ?? null,
    }).returning({
      id: personalAccessTokens.id,
      name: personalAccessTokens.name,
    });
    return row!;
  }

  // ===========================================================================
  // POST /api/tokens
  // ===========================================================================

  describe("POST /api/tokens", () => {
    it("creates a token and returns plain token once", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "CI Token" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.plainToken);
      assert.ok(body.plainToken.startsWith("ah5p_"));
      assert.equal(body.token.name, "CI Token");
      assert.equal(body.token.isExpired, false);
    });

    it("returns 400 for empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/tokens",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "" },
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // ===========================================================================
  // GET /api/tokens
  // ===========================================================================

  describe("GET /api/tokens", () => {
    it("returns non-revoked tokens", async () => {
      await insertToken({ name: "Active Token" });
      await insertToken({ name: "Revoked Token", revokedAt: new Date() });

      const res = await app.inject({
        method: "GET",
        url: "/api/tokens",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { tokens } = res.json();
      assert.equal(tokens.length, 1);
      assert.equal(tokens[0].name, "Active Token");
    });
  });

  // ===========================================================================
  // DELETE /api/tokens/:id
  // ===========================================================================

  describe("DELETE /api/tokens/:id", () => {
    it("revokes a token", async () => {
      const token = await insertToken();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().success, true);
    });

    it("returns 404 for already revoked token", async () => {
      const token = await insertToken({ revokedAt: new Date() });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ===========================================================================
  // PUT /api/tokens/:id — Rename token
  // ===========================================================================

  describe("PUT /api/tokens/:id", () => {
    it("renames a token", async () => {
      const token = await insertToken({ name: "Old Name" });

      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "New Name" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.token.id, token.id);
      assert.equal(body.token.name, "New Name");
    });

    it("trims whitespace from name", async () => {
      const token = await insertToken();

      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "  Trimmed  " },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().token.name, "Trimmed");
    });

    it("returns 400 for empty name", async () => {
      const token = await insertToken();

      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "" },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for name exceeding 100 characters", async () => {
      const token = await insertToken();

      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "a".repeat(101) },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 404 for nonexistent token", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "New Name" },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 404 for revoked token", async () => {
      const token = await insertToken({ revokedAt: new Date() });

      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${token.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "New Name" },
      });

      assert.equal(res.statusCode, 404);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/tokens/${randomUUID()}`,
        payload: { name: "New" },
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
