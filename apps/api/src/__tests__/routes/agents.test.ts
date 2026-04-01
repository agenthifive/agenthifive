import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Agents Routes Tests with Real Test Database
 *
 * Tests: create (with bootstrap secret), list, get by ID, update, delete,
 *        disable/enable, bootstrap-secret.
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createTestWorkspace, createMockTokens } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { policies } from "../../db/schema/policies.js";
import { connections } from "../../db/schema/connections.js";
import { agentBootstrapSecrets } from "../../db/schema/agent-bootstrap-secrets.js";

// =============================================================================
// Test suite
// =============================================================================

describe("Agent Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;

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

    const { default: agentRoutes } = await import("../../routes/agents.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(agentRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[AGENT TEST] Setup complete: workspace=${testWorkspaceId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    await db.delete(agentBootstrapSecrets).execute();
    await db.delete(agents).execute();
  });

  // ===========================================================================
  // POST /api/agents
  // ===========================================================================

  describe("POST /api/agents", () => {
    it("creates agent with bootstrap secret", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "My Agent" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.agent.id);
      assert.equal(body.agent.name, "My Agent");
      assert.equal(body.agent.description, "");
      assert.equal(body.agent.iconUrl, null);
      assert.equal(body.agent.status, "created");
      assert.ok(body.bootstrapSecret, "Should have bootstrapSecret");
      assert.ok(body.bootstrapSecret.startsWith("ah5b_"), "Bootstrap secret should start with ah5b_ prefix");
    });

    it("creates agent with all fields", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          name: "Full Agent",
          description: "A fully configured agent",
          iconUrl: "https://example.com/icon.png",
        },
      });

      assert.equal(res.statusCode, 200);
      const { agent, bootstrapSecret } = res.json();
      assert.equal(agent.name, "Full Agent");
      assert.equal(agent.description, "A fully configured agent");
      assert.equal(agent.iconUrl, "https://example.com/icon.png");
      assert.equal(agent.status, "created");
      assert.ok(bootstrapSecret);
    });

    it("stores bootstrap secret hash in bootstrap secrets table", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "Secret Agent" },
      });

      assert.equal(res.statusCode, 200);
      const { agent } = res.json();

      // Verify secret was stored
      const secrets = await db
        .select()
        .from(agentBootstrapSecrets)
        .where(eq(agentBootstrapSecrets.agentId, agent.id));

      assert.equal(secrets.length, 1);
      assert.equal(secrets[0]!.type, "bootstrap");
      assert.equal(secrets[0]!.consumedAt, null);
      assert.ok(secrets[0]!.expiresAt > new Date());
    });

    it("trims whitespace from name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "  Trimmed Agent  " },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agent.name, "Trimmed Agent");
    });

    it("returns 400 for empty name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "" },
      });

      assert.equal(res.statusCode, 400);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents",
        payload: { name: "Test" },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // GET /api/agents
  // ===========================================================================

  describe("GET /api/agents", () => {
    it("returns all agents for the workspace", async () => {
      await db.insert(agents).values([
        { name: "Agent A", workspaceId: testWorkspaceId },
        { name: "Agent B", workspaceId: testWorkspaceId },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(Array.isArray(body.agents));
      assert.equal(body.agents.length, 2);
      // All new agents default to 'created' status
      for (const agent of body.agents) {
        assert.equal(agent.status, "created");
      }
    });

    it("returns empty array when no agents exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().agents, []);
    });

    it("does not return agents from other workspaces", async () => {
      const otherWs = randomUUID();
      await db.insert(workspaces).values({ id: otherWs, name: "Other", ownerId: randomUUID() });
      await db.insert(agents).values({ name: "Other Agent", workspaceId: otherWs });
      await db.insert(agents).values({ name: "My Agent", workspaceId: testWorkspaceId });

      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agents.length, 1);
      assert.equal(res.json().agents[0].name, "My Agent");

      // Cleanup
      await db.delete(agents).execute();
      await db.delete(workspaces).where(eq(workspaces.id, otherWs));
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // GET /api/agents/:id
  // ===========================================================================

  describe("GET /api/agents/:id", () => {
    it("returns agent by ID with status", async () => {
      const [created] = await db.insert(agents).values({
        name: "Specific Agent",
        description: "A specific agent",
        workspaceId: testWorkspaceId,
        status: "active",
        enrolledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { agent } = res.json();
      assert.equal(agent.name, "Specific Agent");
      assert.equal(agent.status, "active");
      assert.ok(agent.enrolledAt);
    });

    it("returns created status for unenrolled agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "New Agent",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agent.status, "created");
      assert.equal(res.json().agent.enrolledAt, null);
    });

    it("returns 404 when agent not found", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/agents/${randomUUID()}`,
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // PUT /api/agents/:id
  // ===========================================================================

  describe("PUT /api/agents/:id", () => {
    it("updates agent name", async () => {
      const [created] = await db.insert(agents).values({
        name: "Original Name",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "Updated Name" },
      });

      assert.equal(res.statusCode, 200);
      const { agent } = res.json();
      assert.equal(agent.name, "Updated Name");
      assert.ok(agent.updatedAt);
    });

    it("updates description and iconUrl", async () => {
      const [created] = await db.insert(agents).values({
        name: "My Agent",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          description: "New description",
          iconUrl: "https://example.com/new-icon.png",
        },
      });

      assert.equal(res.statusCode, 200);
      const { agent } = res.json();
      assert.equal(agent.description, "New description");
      assert.equal(agent.iconUrl, "https://example.com/new-icon.png");
      assert.equal(agent.name, "My Agent"); // unchanged
    });

    it("clears iconUrl with null", async () => {
      const [created] = await db.insert(agents).values({
        name: "My Agent",
        iconUrl: "https://example.com/icon.png",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { iconUrl: null },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().agent.iconUrl, null);
    });

    it("returns 400 when no fields provided", async () => {
      const [created] = await db.insert(agents).values({
        name: "My Agent",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("At least one field"));
    });

    it("returns 400 for empty name", async () => {
      const [created] = await db.insert(agents).values({
        name: "My Agent",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "" },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 404 for nonexistent agent", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "New Name" },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 404 for agent in another workspace", async () => {
      const otherWs = randomUUID();
      await db.insert(workspaces).values({ id: otherWs, name: "Other", ownerId: randomUUID() });
      const [created] = await db.insert(agents).values({
        name: "Other Agent",
        workspaceId: otherWs,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { name: "Hacked" },
      });

      assert.equal(res.statusCode, 404);

      await db.delete(agents).execute();
      await db.delete(workspaces).where(eq(workspaces.id, otherWs));
    });
  });

  // ===========================================================================
  // POST /api/agents/:id/bootstrap-secret
  // ===========================================================================

  describe("POST /api/agents/:id/bootstrap-secret", () => {
    it("generates bootstrap secret for active agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Active Agent",
        workspaceId: testWorkspaceId,
        status: "active",
        enrolledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/bootstrap-secret`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.bootstrapSecret);
      assert.ok(body.bootstrapSecret.startsWith("ah5b_"));
    });

    it("generates bootstrap secret for created agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Unenrolled Agent",
        workspaceId: testWorkspaceId,
        status: "created",
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/bootstrap-secret`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.bootstrapSecret);
      assert.ok(body.bootstrapSecret.startsWith("ah5b_"));
    });

    it("stores bootstrap secret hash in bootstrap secrets table", async () => {
      const [created] = await db.insert(agents).values({
        name: "Unenrolled Agent",
        workspaceId: testWorkspaceId,
        status: "created",
      }).returning({ id: agents.id });

      await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/bootstrap-secret`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      const secrets = await db.select().from(agentBootstrapSecrets)
        .where(eq(agentBootstrapSecrets.agentId, created!.id));

      assert.equal(secrets.length, 1);
      assert.equal(secrets[0]!.type, "bootstrap");
      assert.ok(secrets[0]!.expiresAt > new Date());
    });

    it("returns 409 for disabled agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Disabled Agent",
        workspaceId: testWorkspaceId,
        status: "disabled",
        disabledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/bootstrap-secret`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });

    it("returns 404 for nonexistent agent", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${randomUUID()}/bootstrap-secret`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ===========================================================================
  // POST /api/agents/:id/disable and /enable
  // ===========================================================================

  describe("POST /api/agents/:id/disable", () => {
    it("disables an active agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Active Agent",
        workspaceId: testWorkspaceId,
        status: "active",
        enrolledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/disable`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().success, true);

      // Verify status changed
      const getRes = await app.inject({
        method: "GET",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.equal(getRes.json().agent.status, "disabled");
    });

    it("returns 409 for already disabled agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Disabled Agent",
        workspaceId: testWorkspaceId,
        status: "disabled",
        disabledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/disable`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });
  });

  describe("POST /api/agents/:id/enable", () => {
    it("enables a disabled agent with public key to active", async () => {
      const [created] = await db.insert(agents).values({
        name: "Disabled Agent",
        workspaceId: testWorkspaceId,
        status: "disabled",
        disabledAt: new Date(),
        publicKeyJwk: { kty: "EC", crv: "P-256", x: "test", y: "test" },
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/enable`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, "active");
    });

    it("enables a disabled agent without public key to created", async () => {
      const [created] = await db.insert(agents).values({
        name: "Disabled Agent",
        workspaceId: testWorkspaceId,
        status: "disabled",
        disabledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/enable`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, "created");
    });

    it("returns 409 for non-disabled agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Active Agent",
        workspaceId: testWorkspaceId,
        status: "active",
        enrolledAt: new Date(),
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "POST",
        url: `/api/agents/${created!.id}/enable`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });
  });

  // ===========================================================================
  // DELETE /api/agents/:id
  // ===========================================================================

  describe("DELETE /api/agents/:id", () => {
    it("deletes an agent", async () => {
      const [created] = await db.insert(agents).values({
        name: "Doomed Agent",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().success, true);

      // Verify it's gone
      const getRes = await app.inject({
        method: "GET",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.equal(getRes.statusCode, 404);
    });

    it("returns 404 for nonexistent agent", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 404 for agent in another workspace", async () => {
      const otherWs = randomUUID();
      await db.insert(workspaces).values({ id: otherWs, name: "Other", ownerId: randomUUID() });
      const [created] = await db.insert(agents).values({
        name: "Other Agent",
        workspaceId: otherWs,
      }).returning({ id: agents.id });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);

      await db.delete(agents).execute();
      await db.delete(workspaces).where(eq(workspaces.id, otherWs));
    });

    it("cascades to policies", async () => {
      // Create agent
      const [agent] = await db.insert(agents).values({
        name: "Agent with Policy",
        workspaceId: testWorkspaceId,
      }).returning({ id: agents.id });

      // Create a connection to bind policy to
      const [conn] = await db.insert(connections).values({
        provider: "google",
        service: "google-gmail",
        label: "Test Gmail",
        status: "healthy",
        workspaceId: testWorkspaceId,
        encryptedTokens: createMockTokens({ accessToken: "test" }),
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      }).returning({ id: connections.id });

      // Create policy bound to agent
      await db.insert(policies).values({
        agentId: agent!.id,
        connectionId: conn!.id,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
      });

      // Verify policy exists
      const beforePolicies = await db.select().from(policies).where(eq(policies.agentId, agent!.id));
      assert.equal(beforePolicies.length, 1);

      // Delete agent
      const res = await app.inject({
        method: "DELETE",
        url: `/api/agents/${agent!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.equal(res.statusCode, 200);

      // Verify policies cascaded
      const afterPolicies = await db.select().from(policies).where(eq(policies.agentId, agent!.id));
      assert.equal(afterPolicies.length, 0);

      // Cleanup connection
      await db.delete(connections).execute();
    });
  });
});
