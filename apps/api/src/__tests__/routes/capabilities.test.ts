import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Capabilities Routes Tests
 *
 * Tests:
 * - GET /capabilities/services — catalog listing
 * - GET /capabilities/me — agent capability status
 * - Scope enforcement (capabilities:read required)
 * - Agent-only enforcement for /me
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
import { createTestWorkspace, createTestConnection, createTestAccessToken } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { connections } from "../../db/schema/connections.js";
import { policies } from "../../db/schema/policies.js";
import { agentPermissionRequests } from "../../db/schema/agent-permission-requests.js";
import { agentAccessTokens } from "../../db/schema/agent-access-tokens.js";

// =============================================================================
// STEP 2: Test suite
// =============================================================================

describe("Capabilities Routes", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testWorkspaceId: string;
  let testAgentId: string;
  let testConnectionId: string;
  let testTelegramConnectionId: string;
  let agentToken: string;
  let userToken: string;

  before(async () => {
    // Warm up pool
    await db.select().from(workspaces).limit(1);
    await sql`SELECT 1`;

    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create workspace
    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });

    // Create agent with active status
    testAgentId = randomUUID();

    await db.insert(agents).values({
      id: testAgentId,
      name: "Test Agent",
      description: "Agent for capabilities tests",
      workspaceId: testWorkspaceId,
      status: "active",
    });

    // Create access token for agent auth
    const { token, hash: tokenHash } = createTestAccessToken();
    agentToken = token;
    await db.insert(agentAccessTokens).values({
      agentId: testAgentId,
      workspaceId: testWorkspaceId,
      tokenHash,
      expiresAt: new Date(Date.now() + 3600_000), // 1 hour from now
    });

    // Create connection
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

    // Create a Telegram connection (singleton service)
    const telegramConn = createTestConnection(testWorkspaceId, {
      provider: "telegram",
      service: "telegram",
      label: "Test Telegram Bot",
      grantedScopes: ["bot:sendMessage"],
    });
    testTelegramConnectionId = telegramConn.id;
    await db.insert(connections).values({
      id: telegramConn.id,
      provider: telegramConn.provider,
      service: telegramConn.service,
      workspaceId: testWorkspaceId,
      label: telegramConn.label,
      status: telegramConn.status,
      grantedScopes: telegramConn.grantedScopes,
      metadata: telegramConn.metadata,
      encryptedTokens: telegramConn.encryptedTokens,
    });

    // Create policies for the agent
    await db.insert(policies).values({
      agentId: testAgentId,
      connectionId: testConnectionId,
      actionTemplateId: "gmail-read",
      allowedModels: ["A", "B"],
      defaultMode: "read_only",
      stepUpApproval: "risk_based",
      allowlists: [],
    });
    await db.insert(policies).values({
      agentId: testAgentId,
      connectionId: testTelegramConnectionId,
      actionTemplateId: "telegram",
      allowedModels: ["B"],
      defaultMode: "read_write",
      stepUpApproval: "never",
      allowlists: [],
    });

    // Create a pending permission request
    await db.insert(agentPermissionRequests).values({
      agentId: testAgentId,
      workspaceId: testWorkspaceId,
      actionTemplateId: "gmail-manage",
      reason: "Need to send emails",
    });

    // Create an approved (resolved) permission request — should NOT appear in pendingRequests
    await db.insert(agentPermissionRequests).values({
      agentId: testAgentId,
      workspaceId: testWorkspaceId,
      actionTemplateId: "calendar-read",
      reason: "Need to check calendar",
      status: "approved",
      resolvedAt: new Date(),
    });

    // User JWT (has capabilities:read scope)
    userToken = await mockJwks.createTestJwt({
      sub: workspace.ownerId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["*"],
      sid: randomUUID(),
    });

    // Import and register routes
    const { default: capabilityRoutes } = await import("../../routes/capabilities.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(capabilityRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    // Cleanup
    await db.delete(agentPermissionRequests).where(
      (await import("drizzle-orm")).eq(agentPermissionRequests.agentId, testAgentId),
    );
    await db.delete(policies).where(
      (await import("drizzle-orm")).eq(policies.agentId, testAgentId),
    );
    const { inArray } = await import("drizzle-orm");
    await db.delete(connections).where(
      inArray(connections.id, [testConnectionId, testTelegramConnectionId]),
    );
    await db.delete(agentAccessTokens).where(
      (await import("drizzle-orm")).eq(agentAccessTokens.agentId, testAgentId),
    );
    await db.delete(agents).where(
      (await import("drizzle-orm")).eq(agents.id, testAgentId),
    );
    await db.delete(workspaces).where(
      (await import("drizzle-orm")).eq(workspaces.id, testWorkspaceId),
    );

    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
    delete process.env.ENCRYPTION_KEY;
  });

  // ─── GET /capabilities/services ─────────────────────────────────

  describe("GET /capabilities/services", () => {
    it("returns full service catalog with action templates", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/services",
        headers: { authorization: `Bearer ${userToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as { services: Array<{ id: string; actions: unknown[] }> };
      assert.ok(Array.isArray(body.services));
      assert.ok(body.services.length > 0);

      // Gmail service should have actions
      const gmail = body.services.find((s) => s.id === "google-gmail");
      assert.ok(gmail, "Gmail service should exist");
      assert.ok(gmail.actions.length >= 2, "Gmail should have at least read and send actions");
    });

    it("rejects requests without capabilities:read scope", async () => {
      const limitedToken = await mockJwks.createTestJwt({
        sub: randomUUID(),
        wid: testWorkspaceId,
        roles: ["owner"],
        scp: ["vault:execute"],
        sid: randomUUID(),
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/services",
        headers: { authorization: `Bearer ${limitedToken}` },
      });

      assert.equal(res.statusCode, 403);
    });

    it("allows wildcard scope", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/services",
        headers: { authorization: `Bearer ${userToken}` },
      });

      assert.equal(res.statusCode, 200);
    });
  });

  // ─── GET /capabilities/me ───────────────────────────────────────

  describe("GET /capabilities/me", () => {
    it("returns agent capabilities via access token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/me",
        headers: { authorization: `Bearer ${agentToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        activeConnections: Array<{ actionTemplateId: string }>;
        pendingRequests: Array<{ actionTemplateId: string }>;
        availableActions: Array<{ id: string }>;
      };

      // Should have gmail-read as active
      assert.ok(body.activeConnections.length >= 1);
      assert.ok(body.activeConnections.some((c) => c.actionTemplateId === "gmail-read"));

      // Should have gmail-manage as pending
      assert.ok(body.pendingRequests.length >= 1);
      assert.ok(body.pendingRequests.some((r) => r.actionTemplateId === "gmail-manage"));

      // gmail-read and gmail-manage should NOT be in available
      const availableIds = body.availableActions.map((a) => a.id);
      assert.ok(!availableIds.includes("gmail-read"), "gmail-read should not be available (active)");
      assert.ok(!availableIds.includes("gmail-manage"), "gmail-manage should not be available (pending)");
    });

    it("returns connectionId: null for singleton services", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/me",
        headers: { authorization: `Bearer ${agentToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        activeConnections: Array<{ connectionId: string | null; service: string; actionTemplateId: string }>;
      };

      // Gmail (non-singleton) should expose connectionId
      const gmailConn = body.activeConnections.find((c) => c.actionTemplateId === "gmail-read");
      assert.ok(gmailConn, "gmail-read connection should exist");
      assert.equal(gmailConn.connectionId, testConnectionId, "non-singleton should expose connectionId");

      // Telegram (singleton) should have connectionId: null
      const telegramConn = body.activeConnections.find((c) => c.actionTemplateId === "telegram");
      assert.ok(telegramConn, "telegram connection should exist");
      assert.equal(telegramConn.connectionId, null, "singleton should have connectionId: null");
    });

    it("excludes resolved permission requests from pendingRequests", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/me",
        headers: { authorization: `Bearer ${agentToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        pendingRequests: Array<{ actionTemplateId: string }>;
      };

      // gmail-manage is pending — should appear
      assert.ok(
        body.pendingRequests.some((r) => r.actionTemplateId === "gmail-manage"),
        "pending gmail-manage should appear",
      );

      // calendar-read was approved — should NOT appear
      assert.ok(
        !body.pendingRequests.some((r) => r.actionTemplateId === "calendar-read"),
        "approved calendar-read should not appear in pendingRequests",
      );
    });

    it("accepts agent access token via X-API-Key header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/me",
        headers: { "x-api-key": agentToken },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        activeConnections: Array<{ actionTemplateId: string }>;
      };
      assert.ok(body.activeConnections.length >= 1);
    });

    it("rejects non-agent callers (user JWT)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/capabilities/me",
        headers: { authorization: `Bearer ${userToken}` },
      });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.payload) as { error: string };
      assert.ok(body.error.includes("agent"));
    });
  });
});
