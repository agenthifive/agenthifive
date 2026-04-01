import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Policies Routes Tests with Real Test Database
 *
 * Tests all 7 policy endpoints: create, list, update model settings,
 * update allowlists, update rate-limits, update time-windows, delete.
 *
 * Setup: pnpm test:db:up
 * Run: DATABASE_URL=postgresql://test:test_password@localhost:5433/agenthifive_test pnpm test
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
import { createTestWorkspace, createTestConnection } from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { connections } from "../../db/schema/connections.js";
import { policies } from "../../db/schema/policies.js";
import { eq } from "drizzle-orm";
import { getDefaultAllowlistsForService } from "@agenthifive/contracts";

// =============================================================================
// STEP 2: Test suite
// =============================================================================

describe("Policy Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  let testWorkspaceId: string;
  let testAgentId: string;
  let testConnectionId: string;

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

    // Create agent
    testAgentId = randomUUID();
    await db.insert(agents).values({
      id: testAgentId,
      name: "Test Agent",
      description: "Agent for policy tests",
      workspaceId: testWorkspaceId,
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

    // Create JWT
    testToken = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["policies:read", "policies:write"],
      sid: "session-789",
    });

    // Import and register routes
    const { default: policyRoutes } = await import("../../routes/policies.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(policyRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[POLICY TEST] Setup complete: workspace=${testWorkspaceId} agent=${testAgentId} connection=${testConnectionId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
    delete process.env.ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    // Clear policies before each test (agent + connection persist)
    await db.delete(policies).execute();
  });

  // ===========================================================================
  // POST /api/policies — Create policy
  // ===========================================================================

  describe("POST /api/policies", () => {
    it("creates a policy with default values", async () => {
      console.log("[POLICY TEST] Creating policy with defaults");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
        },
      });

      console.log(`[POLICY TEST] Create response: ${res.statusCode}`, res.json());
      assert.equal(res.statusCode, 201);
      const { policy } = res.json();
      assert.ok(policy.id, "Policy should have an id");
      assert.equal(policy.agentId, testAgentId);
      assert.equal(policy.connectionId, testConnectionId);
      // google-gmail has no allowedModels override → falls back to ["B"]
      assert.deepEqual(policy.allowedModels, ["B"]);
      assert.equal(policy.defaultMode, "read_only");
      assert.equal(policy.stepUpApproval, "risk_based");
      // Default allowlists auto-populated from service catalog (google-gmail)
      assert.deepEqual(policy.allowlists, getDefaultAllowlistsForService("google-gmail"));
      assert.ok(policy.allowlists.length > 0, "Service defaults should be non-empty");
      assert.equal(policy.rateLimits, null);
      assert.deepEqual(policy.timeWindows, []);
    });

    it("creates a policy with custom values", async () => {
      console.log("[POLICY TEST] Creating policy with custom values");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
          allowedModels: ["B"],
          defaultMode: "read_write",
          stepUpApproval: "always",
        },
      });

      assert.equal(res.statusCode, 201);
      const { policy } = res.json();
      assert.deepEqual(policy.allowedModels, ["B"]);
      assert.equal(policy.defaultMode, "read_write");
      assert.equal(policy.stepUpApproval, "always");
    });

    it("returns 404 when agent not found in workspace", async () => {
      console.log("[POLICY TEST] Agent not found");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: randomUUID(),
          connectionId: testConnectionId,
        },
      });

      assert.equal(res.statusCode, 404);
      assert.ok(res.json().error.includes("Agent not found"));
    });

    it("returns 404 when connection not found in workspace", async () => {
      console.log("[POLICY TEST] Connection not found");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: randomUUID(),
        },
      });

      assert.equal(res.statusCode, 404);
      assert.ok(res.json().error.includes("Connection not found"));
    });

    it("returns 400 when agentId is missing", async () => {
      console.log("[POLICY TEST] Missing agentId");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          connectionId: testConnectionId,
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when connectionId is missing", async () => {
      console.log("[POLICY TEST] Missing connectionId");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for invalid allowedModels", async () => {
      console.log("[POLICY TEST] Invalid allowedModels");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
          allowedModels: ["C"],
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for invalid defaultMode", async () => {
      console.log("[POLICY TEST] Invalid defaultMode");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
          defaultMode: "admin",
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for invalid stepUpApproval", async () => {
      console.log("[POLICY TEST] Invalid stepUpApproval");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
          stepUpApproval: "invalid",
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("requires authentication", async () => {
      console.log("[POLICY TEST] Auth required for POST");
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
        },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // GET /api/policies — List policies
  // ===========================================================================

  describe("GET /api/policies", () => {
    it("returns all policies for the workspace", async () => {
      console.log("[POLICY TEST] List policies");
      // Create two policies
      await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      });
      await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_write",
        stepUpApproval: "always",
        allowlists: [],
        timeWindows: [],
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { policies: policyList } = res.json();
      assert.ok(Array.isArray(policyList));
      assert.equal(policyList.length, 2);
      // Should have all expected fields
      assert.ok(policyList[0].id);
      assert.ok(policyList[0].agentId);
      assert.ok(policyList[0].connectionId);
      assert.ok(policyList[0].allowedModels);
    });

    it("returns empty array when workspace has no agents", async () => {
      console.log("[POLICY TEST] List with no agents (different workspace)");
      // Create a separate JWKS token for a different workspace
      const otherWorkspaceId = randomUUID();
      await db.insert(workspaces).values({
        id: otherWorkspaceId,
        name: "Other Workspace",
        ownerId: randomUUID(),
      });

      const otherToken = await mockJwks.createTestJwt({
        sub: "other-user",
        wid: otherWorkspaceId,
        roles: ["owner"],
        scp: ["policies:read"],
        sid: "session-other",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/policies",
        headers: { authorization: `Bearer ${otherToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().policies, []);

      // Cleanup other workspace
      await db.delete(workspaces).where(eq(workspaces.id, otherWorkspaceId));
    });

    it("requires authentication", async () => {
      console.log("[POLICY TEST] Auth required for GET");
      const res = await app.inject({
        method: "GET",
        url: "/api/policies",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id — Update model settings
  // ===========================================================================

  describe("PUT /api/policies/:id", () => {
    it("updates allowedModels, defaultMode, and stepUpApproval", async () => {
      console.log("[POLICY TEST] Update model settings");
      // Create a policy first
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "risk_based",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowedModels: ["B"],
          defaultMode: "read_write",
          stepUpApproval: "always",
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.deepEqual(policy.allowedModels, ["B"]);
      assert.equal(policy.defaultMode, "read_write");
      assert.equal(policy.stepUpApproval, "always");
    });

    it("supports partial update", async () => {
      console.log("[POLICY TEST] Partial update");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "risk_based",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          defaultMode: "custom",
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      // Only defaultMode should change
      assert.equal(policy.defaultMode, "custom");
      assert.deepEqual(policy.allowedModels, ["A", "B"]); // unchanged
      assert.equal(policy.stepUpApproval, "risk_based"); // unchanged
    });

    it("returns 404 when policy not found", async () => {
      console.log("[POLICY TEST] Update 404");
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { defaultMode: "read_write" },
      });

      assert.equal(res.statusCode, 404);
    });

    it("regenerates rules when securityPreset changes", async () => {
      console.log("[POLICY TEST] Preset switching - rules regeneration");

      // Create policy with contacts-manage template at strict tier
      // (using existing gmail connection — actionTemplateId drives template lookup, not service)
      const { generatePolicyFromTemplate } = await import("../../services/policy-generator.js");
      const strictConfig = generatePolicyFromTemplate("contacts-manage", "strict");

      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        actionTemplateId: "contacts-manage",
        securityPreset: "strict",
        allowedModels: ["B"],
        defaultMode: "custom",
        stepUpApproval: strictConfig.stepUpApproval,
        allowlists: strictConfig.allowlists,
        rateLimits: strictConfig.rateLimits,
        timeWindows: strictConfig.timeWindows,
        rules: strictConfig.rules,
      }).returning({ id: policies.id });

      // Verify strict has denyFields (phoneNumbers, biographies, etc.) across all response rules
      const strictRules = strictConfig.rules as any;
      const strictAllDenyFields = strictRules.response.flatMap((r: any) => r.filter?.denyFields ?? []);
      assert.ok(strictAllDenyFields.length > 0, "Strict tier should have response rules with denyFields");
      assert.ok(strictAllDenyFields.includes("phoneNumbers"), "Strict should deny phoneNumbers");
      assert.ok(strictAllDenyFields.includes("biographies"), "Strict should deny biographies");

      // Switch to standard preset
      const res1 = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { securityPreset: "standard" },
      });
      assert.equal(res1.statusCode, 200, `Expected 200 but got ${res1.statusCode}: ${res1.body}`);
      const policy1 = res1.json().policy;

      // Standard now uses dr-contact-notes + dr-contact-pii + cs-pii-redact, with fieldStepUpEnabled
      const standardResponse = policy1.rules?.response ?? [];
      console.log("[POLICY TEST] Standard rules response:", JSON.stringify(standardResponse, null, 2));
      const allDenyFields = standardResponse.flatMap((r: any) => r.filter?.denyFields ?? []);
      assert.ok(allDenyFields.includes("biographies"), "Standard should deny biographies (dr-contact-notes)");
      assert.ok(allDenyFields.includes("phoneNumbers"), "Standard should deny phoneNumbers (dr-contact-pii, relaxed via field step-up)");
      assert.ok(policy1.rules?.fieldStepUpEnabled, "Standard contacts should have fieldStepUpEnabled");

      // Switch back to strict preset
      const res2 = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { securityPreset: "strict" },
      });
      assert.equal(res2.statusCode, 200, `Expected 200 but got ${res2.statusCode}: ${res2.body}`);
      const policy2 = res2.json().policy;

      // Strict should have denyFields back (phoneNumbers, biographies)
      const strictResponse2 = policy2.rules?.response ?? [];
      console.log("[POLICY TEST] Strict rules response after switch:", JSON.stringify(strictResponse2, null, 2));
      const strictAllDeny2 = strictResponse2.flatMap((r: any) => r.filter?.denyFields ?? []);
      assert.ok(strictAllDeny2.length > 0, "Strict tier should still have denyFields after switching back");
      assert.ok(strictAllDeny2.includes("phoneNumbers"), "Strict should deny phoneNumbers after switching back");

      // Also verify DB state directly
      const [dbPolicy] = await db.select({ rules: policies.rules }).from(policies).where(eq(policies.id, created!.id));
      const dbRules = dbPolicy!.rules as any;
      const dbAllDeny = dbRules.response.flatMap((r: any) => r.filter?.denyFields ?? []);
      assert.ok(dbAllDeny.length > 0, "DB rules should have denyFields");
      assert.ok(dbAllDeny.includes("phoneNumbers"), "DB should have phoneNumbers in denyFields");
    });

    it("returns 400 for invalid allowedModels value", async () => {
      console.log("[POLICY TEST] Update invalid allowedModels");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { allowedModels: ["C"] },
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id/allowlists
  // ===========================================================================

  describe("PUT /api/policies/:id/allowlists", () => {
    it("sets valid allowlist entries", async () => {
      console.log("[POLICY TEST] Set allowlists");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/allowlists`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowlists: [
            {
              baseUrl: "https://www.googleapis.com",
              methods: ["GET"],
              pathPatterns: ["/gmail/v1/users/me/messages/*"],
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.allowlists.length, 1);
      assert.equal(policy.allowlists[0].baseUrl, "https://www.googleapis.com");
      assert.deepEqual(policy.allowlists[0].methods, ["GET"]);
    });

    it("sets multiple allowlist entries", async () => {
      console.log("[POLICY TEST] Multiple allowlists");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["B"],
        defaultMode: "read_write",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/allowlists`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowlists: [
            {
              baseUrl: "https://www.googleapis.com",
              methods: ["GET", "POST"],
              pathPatterns: ["/gmail/v1/users/me/messages/*"],
            },
            {
              baseUrl: "https://graph.microsoft.com",
              methods: ["GET"],
              pathPatterns: ["/v1.0/me/messages", "/v1.0/me/calendar/*"],
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().policy.allowlists.length, 2);
    });

    it("returns 400 for non-HTTPS base URL", async () => {
      console.log("[POLICY TEST] Non-HTTPS allowlist");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/allowlists`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowlists: [
            {
              baseUrl: "http://insecure.example.com",
              methods: ["GET"],
              pathPatterns: ["/data"],
            },
          ],
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("HTTPS"));
    });

    it("returns 400 for invalid HTTP method", async () => {
      console.log("[POLICY TEST] Invalid HTTP method in allowlist");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/allowlists`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowlists: [
            {
              baseUrl: "https://api.example.com",
              methods: ["TRACE"],
              pathPatterns: ["/data"],
            },
          ],
        },
      });

      // Fastify validates body against schema enum before handler runs
      assert.equal(res.statusCode, 400);
    });

    it("returns 404 when policy not found", async () => {
      console.log("[POLICY TEST] Allowlist update 404");
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/allowlists`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          allowlists: [
            {
              baseUrl: "https://api.example.com",
              methods: ["GET"],
              pathPatterns: ["/data"],
            },
          ],
        },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id/rate-limits
  // ===========================================================================

  describe("PUT /api/policies/:id/rate-limits", () => {
    it("sets rate limits", async () => {
      console.log("[POLICY TEST] Set rate limits");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rate-limits`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rateLimits: {
            maxRequestsPerHour: 100,
            maxPayloadSizeBytes: 1048576,
            maxResponseSizeBytes: 5242880,
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.rateLimits.maxRequestsPerHour, 100);
      assert.equal(policy.rateLimits.maxPayloadSizeBytes, 1048576);
      assert.equal(policy.rateLimits.maxResponseSizeBytes, 5242880);
    });

    it("removes rate limits by passing null", async () => {
      console.log("[POLICY TEST] Remove rate limits");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        rateLimits: { maxRequestsPerHour: 50 },
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rate-limits`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rateLimits: null,
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().policy.rateLimits, null);
    });

    it("returns 400 for negative values", async () => {
      console.log("[POLICY TEST] Negative rate limit values");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rate-limits`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rateLimits: {
            maxRequestsPerHour: -1,
          },
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 when maxRequestsPerHour is missing but other limits set", async () => {
      console.log("[POLICY TEST] Missing maxRequestsPerHour");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rate-limits`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rateLimits: {
            maxPayloadSizeBytes: 1024,
          },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("maxRequestsPerHour"));
    });

    it("returns 404 when policy not found", async () => {
      console.log("[POLICY TEST] Rate limits 404");
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/rate-limits`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rateLimits: { maxRequestsPerHour: 10 },
        },
      });

      assert.equal(res.statusCode, 404);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id/time-windows
  // ===========================================================================

  describe("PUT /api/policies/:id/time-windows", () => {
    it("sets valid time windows", async () => {
      console.log("[POLICY TEST] Set time windows");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            {
              dayOfWeek: 1, // Monday
              startHour: 9,
              endHour: 17,
              timezone: "America/New_York",
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.timeWindows.length, 1);
      assert.equal(policy.timeWindows[0].dayOfWeek, 1);
      assert.equal(policy.timeWindows[0].startHour, 9);
      assert.equal(policy.timeWindows[0].endHour, 17);
      assert.equal(policy.timeWindows[0].timezone, "America/New_York");
    });

    it("allows overnight windows (startHour > endHour)", async () => {
      console.log("[POLICY TEST] Overnight time window");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            {
              dayOfWeek: 5, // Friday
              startHour: 22,
              endHour: 6,
              timezone: "Europe/London",
            },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      const tw = res.json().policy.timeWindows[0];
      assert.equal(tw.startHour, 22);
      assert.equal(tw.endHour, 6);
    });

    it("allows multiple time windows", async () => {
      console.log("[POLICY TEST] Multiple time windows");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            { dayOfWeek: 1, startHour: 9, endHour: 17, timezone: "America/New_York" },
            { dayOfWeek: 2, startHour: 9, endHour: 17, timezone: "America/New_York" },
            { dayOfWeek: 3, startHour: 9, endHour: 17, timezone: "America/New_York" },
          ],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().policy.timeWindows.length, 3);
    });

    it("returns 400 for invalid dayOfWeek", async () => {
      console.log("[POLICY TEST] Invalid dayOfWeek");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            { dayOfWeek: 7, startHour: 9, endHour: 17, timezone: "UTC" },
          ],
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 400 for invalid timezone", async () => {
      console.log("[POLICY TEST] Invalid timezone");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            { dayOfWeek: 1, startHour: 9, endHour: 17, timezone: "Invalid/Timezone" },
          ],
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("Invalid timezone"));
    });

    it("returns 404 when policy not found", async () => {
      console.log("[POLICY TEST] Time windows 404");
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [
            { dayOfWeek: 0, startHour: 0, endHour: 23, timezone: "UTC" },
          ],
        },
      });

      assert.equal(res.statusCode, 404);
    });

    it("clears time windows with empty array", async () => {
      console.log("[POLICY TEST] Clear time windows");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [{ dayOfWeek: 1, startHour: 9, endHour: 17, timezone: "UTC" }],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/time-windows`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          timeWindows: [],
        },
      });

      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().policy.timeWindows, []);
    });
  });

  // ===========================================================================
  // GET /api/policies/:id/rules
  // ===========================================================================

  describe("GET /api/policies/:id/rules", () => {
    it("returns default empty rules for a new policy", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "GET",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json();
      assert.deepEqual(rules.request, []);
      assert.deepEqual(rules.response, []);
    });

    it("returns saved rules after PUT", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
        rules: {
          request: [
            { label: "Block deletes", match: { methods: ["DELETE"] }, action: "deny" },
          ],
          response: [],
        },
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "GET",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json();
      assert.equal(rules.request.length, 1);
      assert.equal(rules.request[0].label, "Block deletes");
      assert.equal(rules.request[0].action, "deny");
      assert.deepEqual(rules.request[0].match.methods, ["DELETE"]);
    });

    it("returns 404 for nonexistent policy", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/policies/${randomUUID()}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/policies/${randomUUID()}/rules`,
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id/rules
  // ===========================================================================

  describe("PUT /api/policies/:id/rules", () => {
    it("sets valid request rules", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [
              {
                label: "Allow reads",
                match: { methods: ["GET"] },
                action: "allow",
              },
              {
                label: "Block deletes",
                match: { methods: ["DELETE"] },
                action: "deny",
              },
              {
                label: "Approve writes",
                match: { methods: ["POST", "PUT", "PATCH"] },
                action: "require_approval",
              },
            ],
            response: [],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json().policy;
      assert.equal(rules.request.length, 3);
      assert.equal(rules.request[0].label, "Allow reads");
      assert.equal(rules.request[0].action, "allow");
      assert.equal(rules.request[1].label, "Block deletes");
      assert.equal(rules.request[1].action, "deny");
      assert.equal(rules.request[2].label, "Approve writes");
      assert.equal(rules.request[2].action, "require_approval");
      assert.deepEqual(rules.response, []);
    });

    it("sets valid response rules with field filtering", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [],
            response: [
              {
                label: "Strip sensitive fields",
                match: { urlPattern: "/users" },
                filter: {
                  denyFields: ["password", "ssn", "creditCard"],
                },
              },
            ],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json().policy;
      assert.equal(rules.response.length, 1);
      assert.equal(rules.response[0].label, "Strip sensitive fields");
      assert.deepEqual(rules.response[0].filter.denyFields, ["password", "ssn", "creditCard"]);
    });

    it("sets response rules with PII redaction", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [],
            response: [
              {
                label: "Redact PII",
                match: {},
                filter: {
                  redact: [
                    { type: "email" },
                    { type: "phone" },
                    { type: "ssn" },
                    { type: "custom", pattern: "\\bSECRET-[A-Z0-9]+\\b", replacement: "[REMOVED]" },
                  ],
                },
              },
            ],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json().policy;
      assert.equal(rules.response[0].filter.redact.length, 4);
      assert.equal(rules.response[0].filter.redact[0].type, "email");
      assert.equal(rules.response[0].filter.redact[3].type, "custom");
      assert.equal(rules.response[0].filter.redact[3].replacement, "[REMOVED]");
    });

    it("sets request rules with body conditions", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [
              {
                label: "Block external sharing",
                match: {
                  methods: ["POST"],
                  urlPattern: "/drive/v3/permissions",
                  body: [
                    { path: "type", op: "eq", value: "anyone" },
                  ],
                },
                action: "deny",
              },
            ],
            response: [],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json().policy;
      assert.equal(rules.request[0].match.body.length, 1);
      assert.equal(rules.request[0].match.body[0].path, "type");
      assert.equal(rules.request[0].match.body[0].op, "eq");
      assert.equal(rules.request[0].match.body[0].value, "anyone");
    });

    it("returns 400 for invalid regex in urlPattern", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [
              {
                label: "Bad regex",
                match: { urlPattern: "[invalid(regex" },
                action: "deny",
              },
            ],
            response: [],
          },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("Invalid rules"));
      assert.ok(res.json().error.includes("urlPattern"));
    });

    it("returns 400 for invalid regex in body matches condition", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [
              {
                label: "Bad body regex",
                match: {
                  body: [{ path: "text", op: "matches", value: "[broken(" }],
                },
                action: "deny",
              },
            ],
            response: [],
          },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("Invalid rules"));
    });

    it("returns 400 when allowFields and denyFields are both set", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [],
            response: [
              {
                label: "Conflict",
                match: {},
                filter: {
                  allowFields: ["name"],
                  denyFields: ["password"],
                },
              },
            ],
          },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("mutually exclusive"));
    });

    it("returns 400 for invalid custom redact pattern", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: {
            request: [],
            response: [
              {
                label: "Bad custom regex",
                match: {},
                filter: {
                  redact: [{ type: "custom", pattern: "[broken(" }],
                },
              },
            ],
          },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("Invalid rules"));
    });

    it("clears rules with empty arrays", async () => {
      // First set some rules
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
        rules: {
          request: [{ label: "x", match: { methods: ["GET"] }, action: "allow" }],
          response: [],
        },
      }).returning({ id: policies.id });

      // Clear them
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: { request: [], response: [] },
        },
      });

      assert.equal(res.statusCode, 200);
      const { rules } = res.json().policy;
      assert.deepEqual(rules.request, []);
      assert.deepEqual(rules.response, []);

      // Verify via GET
      const getRes = await app.inject({
        method: "GET",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.deepEqual(getRes.json().rules.request, []);
      assert.deepEqual(getRes.json().rules.response, []);
    });

    it("round-trips: PUT then GET returns same rules", async () => {
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const rulesPayload = {
        request: [
          {
            label: "Block external sharing",
            match: {
              methods: ["POST"],
              urlPattern: "/drive/v3/permissions",
              body: [
                { path: "type", op: "eq", value: "anyone" },
                { path: "role", op: "in", value: ["writer", "owner"] },
              ],
            },
            action: "deny",
          },
          {
            label: "Allow reads",
            match: { methods: ["GET"] },
            action: "allow",
          },
        ],
        response: [
          {
            label: "Redact emails",
            match: { urlPattern: "/contacts" },
            filter: {
              redact: [{ type: "email" }],
            },
          },
        ],
      };

      // PUT
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { rules: rulesPayload },
      });
      assert.equal(putRes.statusCode, 200);

      // GET
      const getRes = await app.inject({
        method: "GET",
        url: `/api/policies/${created!.id}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.equal(getRes.statusCode, 200);

      const retrieved = getRes.json().rules;
      assert.equal(retrieved.request.length, 2);
      assert.equal(retrieved.request[0].label, "Block external sharing");
      assert.equal(retrieved.request[0].action, "deny");
      assert.deepEqual(retrieved.request[0].match.methods, ["POST"]);
      assert.equal(retrieved.request[0].match.body.length, 2);
      assert.equal(retrieved.request[1].label, "Allow reads");
      assert.equal(retrieved.response.length, 1);
      assert.equal(retrieved.response[0].label, "Redact emails");
      assert.equal(retrieved.response[0].filter.redact[0].type, "email");
    });

    it("returns 404 for nonexistent policy", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/rules`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          rules: { request: [], response: [] },
        },
      });

      assert.equal(res.statusCode, 404);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/rules`,
        payload: {
          rules: { request: [], response: [] },
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("includes rules in policy create response", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          agentId: testAgentId,
          connectionId: testConnectionId,
        },
      });

      assert.equal(res.statusCode, 201);
      const { policy } = res.json();
      assert.ok(policy.rules, "Policy response should include rules");
      assert.deepEqual(policy.rules.request, []);
      assert.deepEqual(policy.rules.response, []);
    });

    it("includes rules in policy list response", async () => {
      await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
        rules: {
          request: [{ label: "test", match: { methods: ["GET"] }, action: "allow" }],
          response: [],
        },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const { policies: policyList } = res.json();
      assert.equal(policyList.length, 1);
      assert.ok(policyList[0].rules, "List response should include rules");
      assert.equal(policyList[0].rules.request.length, 1);
      assert.equal(policyList[0].rules.request[0].label, "test");
    });
  });

  // ===========================================================================
  // DELETE /api/policies/:id
  // ===========================================================================

  describe("DELETE /api/policies/:id", () => {
    it("deletes an existing policy", async () => {
      console.log("[POLICY TEST] Delete policy");
      const [created] = await db.insert(policies).values({
        agentId: testAgentId,
        connectionId: testConnectionId,
        allowedModels: ["A", "B"],
        defaultMode: "read_only",
        stepUpApproval: "never",
        allowlists: [],
        timeWindows: [],
      }).returning({ id: policies.id });

      const res = await app.inject({
        method: "DELETE",
        url: `/api/policies/${created!.id}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().deleted, true);

      // Verify it's gone from DB
      const remaining = await db.select().from(policies).where(eq(policies.id, created!.id));
      assert.equal(remaining.length, 0);
    });

    it("returns 404 when policy not found", async () => {
      console.log("[POLICY TEST] Delete 404");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/policies/${randomUUID()}`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("requires authentication", async () => {
      console.log("[POLICY TEST] Auth required for DELETE");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/policies/${randomUUID()}`,
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // PUT /api/policies/:id/provider-constraints — Update provider constraints
  // ===========================================================================

  describe("PUT /api/policies/:id/provider-constraints", () => {
    let telegramConnectionId: string;
    let microsoftConnectionId: string;

    before(async () => {
      // Create Telegram connection for provider-constraints tests
      const tgConn = createTestConnection(testWorkspaceId, {
        provider: "telegram",
        service: "telegram",
        label: "Test Telegram for Constraints",
      });
      telegramConnectionId = tgConn.id;
      await db.insert(connections).values({
        id: tgConn.id,
        provider: "telegram",
        service: "telegram",
        workspaceId: testWorkspaceId,
        label: tgConn.label,
        status: "healthy",
        grantedScopes: ["bot:sendMessage"],
        metadata: { botId: 123, botUsername: "testbot" },
        encryptedTokens: tgConn.encryptedTokens,
      });

      // Create Microsoft Teams connection
      const msConn = createTestConnection(testWorkspaceId, {
        provider: "microsoft",
        service: "microsoft-teams",
        label: "Test Teams for Constraints",
      });
      microsoftConnectionId = msConn.id;
      await db.insert(connections).values({
        id: msConn.id,
        provider: "microsoft",
        service: "microsoft-teams",
        workspaceId: testWorkspaceId,
        label: msConn.label,
        status: "healthy",
        grantedScopes: ["https://graph.microsoft.com/.default"],
        metadata: { tenantId: "test-tenant-123" },
        encryptedTokens: msConn.encryptedTokens,
      });
    });

    it("sets Telegram provider constraints", async () => {
      // Create policy for Telegram connection
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: telegramConnectionId },
      });
      assert.equal(createRes.statusCode, 201);
      const policyId = createRes.json().policy.id;

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: {
            provider: "telegram",
            allowedChatIds: ["12345", "67890"],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.providerConstraints.provider, "telegram");
      assert.deepEqual(policy.providerConstraints.allowedChatIds, ["12345", "67890"]);
    });

    it("sets Microsoft provider constraints", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: microsoftConnectionId },
      });
      assert.equal(createRes.statusCode, 201);
      const policyId = createRes.json().policy.id;

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: {
            provider: "microsoft",
            allowedTenantIds: ["tenant-1"],
            allowedChatIds: ["chat-1", "chat-2"],
            allowedChannelIds: ["channel-1"],
          },
        },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.providerConstraints.provider, "microsoft");
      assert.deepEqual(policy.providerConstraints.allowedTenantIds, ["tenant-1"]);
      assert.deepEqual(policy.providerConstraints.allowedChatIds, ["chat-1", "chat-2"]);
      assert.deepEqual(policy.providerConstraints.allowedChannelIds, ["channel-1"]);
    });

    it("clears constraints with null", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: telegramConnectionId },
      });
      const policyId = createRes.json().policy.id;

      // Set constraints first
      await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: { provider: "telegram", allowedChatIds: ["111"] },
        },
      });

      // Clear them
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { providerConstraints: null },
      });

      assert.equal(res.statusCode, 200);
      const { policy } = res.json();
      assert.equal(policy.providerConstraints, null);
    });

    it("rejects mismatched provider", async () => {
      // Create policy for Google connection (testConnectionId is google-gmail)
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: testConnectionId },
      });
      const policyId = createRes.json().policy.id;

      // Try to set Telegram constraints on a Google connection
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: { provider: "telegram", allowedChatIds: ["123"] },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("mismatch"));
    });

    it("rejects invalid constraint shape", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: telegramConnectionId },
      });
      const policyId = createRes.json().policy.id;

      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${policyId}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: { provider: "telegram" },  // missing allowedChatIds
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 404 for non-existent policy", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/policies/${randomUUID()}/provider-constraints`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          providerConstraints: { provider: "telegram", allowedChatIds: ["123"] },
        },
      });

      assert.equal(res.statusCode, 404);
    });

    it("includes providerConstraints in policy responses", async () => {
      // Create policy and verify providerConstraints is null by default
      const createRes = await app.inject({
        method: "POST",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
        payload: { agentId: testAgentId, connectionId: telegramConnectionId },
      });
      assert.equal(createRes.statusCode, 201);
      const { policy } = createRes.json();
      assert.equal(policy.providerConstraints, null);

      // Verify list endpoint also includes it
      const listRes = await app.inject({
        method: "GET",
        url: "/api/policies",
        headers: { authorization: `Bearer ${testToken}` },
      });
      assert.equal(listRes.statusCode, 200);
      const listed = listRes.json().policies.find((p: { id: string }) => p.id === policy.id);
      assert.ok(listed, "Policy found in list");
      assert.equal(listed.providerConstraints, null);
    });
  });
});
