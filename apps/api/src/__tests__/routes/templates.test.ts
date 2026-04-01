import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Templates Routes Tests
 *
 * Tests the allowlist template lookup endpoint.
 * Templates are static data from @agenthifive/contracts, no DB needed beyond auth.
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

describe("Template Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;

  before(async () => {
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    const workspace = createTestWorkspace();
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
    });

    testToken = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: workspace.id,
      roles: ["owner"],
      scp: ["templates:read"],
      sid: "session-789",
    });

    const { default: templateRoutes } = await import("../../routes/templates.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(templateRoutes, { prefix: "/api" });
    await app.ready();

    console.log("[TEMPLATE TEST] Setup complete");
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  // ===========================================================================
  // GET /api/templates/:provider
  // ===========================================================================

  describe("GET /api/templates/:provider", () => {
    it("returns Google templates", async () => {
      console.log("[TEMPLATE TEST] Google templates");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/google",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { templates } = res.json();
      assert.ok(Array.isArray(templates));
      assert.ok(templates.length >= 2, "Should have multiple Google templates");
      // Verify template structure
      const gmail = templates.find((t: any) => t.name.includes("Gmail"));
      assert.ok(gmail, "Should have a Gmail template");
      assert.ok(gmail.description);
      assert.ok(gmail.allowlists);
    });

    it("returns Microsoft templates", async () => {
      console.log("[TEMPLATE TEST] Microsoft templates");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/microsoft",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { templates } = res.json();
      assert.ok(templates.length >= 2, "Should have multiple Microsoft templates");
    });

    it("returns Telegram templates", async () => {
      console.log("[TEMPLATE TEST] Telegram templates");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/telegram",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { templates } = res.json();
      assert.ok(templates.length >= 1, "Should have Telegram templates");
    });

    it("returns empty array for unknown provider", async () => {
      console.log("[TEMPLATE TEST] Unknown provider");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/unknown-provider",
        headers: { authorization: `Bearer ${testToken}` },
      });

      // Fastify schema validates provider enum, so this should be 400
      // unless provider is not in enum, then Fastify rejects
      assert.ok([200, 400].includes(res.statusCode));
      if (res.statusCode === 200) {
        assert.deepEqual(res.json().templates, []);
      }
    });

    it("validates template structure has required fields", async () => {
      console.log("[TEMPLATE TEST] Template structure");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/google",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { templates } = res.json();
      for (const t of templates) {
        assert.ok(t.name, "Template should have name");
        assert.ok(t.description, "Template should have description");
      }
    });

    it("requires authentication", async () => {
      console.log("[TEMPLATE TEST] Auth required");
      const res = await app.inject({
        method: "GET",
        url: "/api/templates/google",
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
