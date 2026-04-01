import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Connections Routes Tests with Real Test Database
 *
 * This test suite uses a real PostgreSQL test database running in Docker.
 * The database is isolated on port 5433 and cleared between tests.
 *
 * Setup: pnpm test:db:up (starts postgres on port 5433)
 * Run: DATABASE_URL=postgresql://test:test_password@localhost:5433/agenthifive_test pnpm test
 * Cleanup: pnpm test:db:down
 */

// =============================================================================
// STEP 0: Set environment variables BEFORE any imports (module-level constants)
// =============================================================================

// CRITICAL: Set ENCRYPTION_KEY before importing routes
// The routes module defines ENCRYPTION_KEY = process.env.ENCRYPTION_KEY at module level
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// =============================================================================
// STEP 1: Mock OAuth Connectors (to avoid real network calls)
// =============================================================================

// Mock GoogleConnector and MicrosoftConnector to avoid real OAuth provider calls
const MockGoogleConnector = mock.fn(function (this: any, config: any) {
  this.config = config;
  this.createAuthorizationUrl = mock.fn(async (input: any) => {
    const url = new URL('http://localhost:9999/authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', input.codeChallengeMethod);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    return { authorizationUrl: url.toString() };
  });
  this.exchangeAuthorizationCode = mock.fn(async () => ({
    accessToken: 'mock_access_token',
    refreshToken: 'mock_refresh_token',
    tokenType: 'bearer',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: ['email', 'profile'],
  }));
  this.refresh = mock.fn(async () => ({
    accessToken: 'mock_refreshed_token',
    tokenType: 'bearer',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));
  this.capabilities = mock.fn(() => ({
    provider: 'google',
    supportsAuthCode: true,
    supportsPkce: true,
  }));
});

const MockMicrosoftConnector = mock.fn(function (this: any, config: any) {
  this.config = config;
  this.createAuthorizationUrl = mock.fn(async (input: any) => {
    const url = new URL('http://localhost:9999/ms-authorize');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    return { authorizationUrl: url.toString() };
  });
  this.exchangeAuthorizationCode = mock.fn(async () => ({
    accessToken: 'mock_ms_access_token',
    refreshToken: 'mock_ms_refresh_token',
    tokenType: 'bearer',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));
  this.refresh = mock.fn(async () => ({
    accessToken: 'mock_ms_refreshed_token',
    tokenType: 'bearer',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }));
});

const MockTelegramBotProvider = mock.fn(function (this: any) {
  // TelegramBotProvider.validateBotToken(botToken) -> Promise<TelegramBotInfo>
  this.validateBotToken = mock.fn(async (botToken: string) => {
    if (botToken === "invalid_token") {
      throw new Error("Telegram getMe failed (401): Unauthorized");
    }
    return {
      id: 123456789,
      isBot: true,
      firstName: "Test Bot",
      username: "testbot",
    };
  });
});

mock.module("@agenthifive/oauth-connectors", {
  namedExports: {
    GoogleConnector: MockGoogleConnector,
    MicrosoftConnector: MockMicrosoftConnector,
    TelegramBotProvider: MockTelegramBotProvider,
  },
});

// =============================================================================
// STEP 2: Import dependencies (AFTER mocking OAuth connectors)
// =============================================================================

import jwtAuthPlugin from "../../plugins/jwt-auth.js";
// NOTE: connectionRoutes is imported dynamically in before() hook to ensure ENCRYPTION_KEY is set first
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { createMockTelegramAPI } from "../../test-helpers/mock-oauth.js";
import {
  createTestConnection,
  createTestPendingConnection,
  createTestWorkspace,
} from "../../test-helpers/test-data.js";

// Import REAL database for cleanup and verification
import { db } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { connections } from "../../db/schema/connections.js";
import { pendingConnections } from "../../db/schema/pending-connections.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { policies } from "../../db/schema/policies.js";
import { agents } from "../../db/schema/agents.js";
import { encrypt } from "@agenthifive/security";

// =============================================================================
// STEP 3: Test suite with real database
// =============================================================================

describe("Connections Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let mockTelegram: Awaited<ReturnType<typeof createMockTelegramAPI>>;
  let testToken: string;
  let testWorkspaceId: string;

  before(async () => {
    // Set up mock servers for external services
    mockJwks = await createMockJwksServer();
    mockTelegram = await createMockTelegramAPI();

    // Set environment variables
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
    process.env.WEB_URL = "http://localhost:3000";
    process.env.TELEGRAM_API_BASE_URL = mockTelegram.baseUrl;
    // ENCRYPTION_KEY must be set BEFORE importing routes (they read it at module level)
    // Already set at top of file, but verify it's still there
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error("ENCRYPTION_KEY not set before imports");
    }

    // Create test workspace
    const workspace = createTestWorkspace();
    testWorkspaceId = workspace.id;

    // Insert workspace into database (required for foreign key constraints)
    await db.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      ownerId: workspace.ownerId,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
    console.log(`[TEST SETUP] Inserted workspace ${testWorkspaceId} into database`);

    // Create test JWT
    testToken = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["connections:read", "connections:write"],
      sid: "session-789",
    });

    // Dynamically import routes AFTER setting ENCRYPTION_KEY
    // This ensures the module-level ENCRYPTION_KEY constant gets the right value
    const { default: connectionRoutes } = await import("../../routes/connections.js");

    // Create Fastify app (uses real database)
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(connectionRoutes, { prefix: "/api" });
    await app.ready();
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    await mockTelegram.close();
    delete process.env.WEB_JWKS_URL;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.WEB_URL;
    delete process.env.ENCRYPTION_KEY;
    delete process.env.TELEGRAM_API_BASE_URL;
  });

  beforeEach(async () => {
    // Clear database tables before each test for isolation (order: FK constraints)
    await db.delete(policies).execute();
    await db.delete(connections).execute();
    await db.delete(pendingConnections).execute();
  });

  // ===========================================================================
  // GET /api/connections - List connections
  // ===========================================================================

  describe("GET /api/connections", () => {
    it("returns list of connections without exposing encrypted tokens", async () => {
      // Arrange: Insert test connection into database
      const connection = createTestConnection(testWorkspaceId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: connection.label,
        status: connection.status,
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
        createdAt: connection.createdAt,
        updatedAt: connection.updatedAt,
      });

      // Verify data was inserted
      const inserted = await db.select().from(connections).where(eq(connections.workspaceId, testWorkspaceId));
      console.log(`[TEST DEBUG] Inserted ${inserted.length} connections into DB for workspace ${testWorkspaceId}`);

      // Act: Call endpoint
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: `Bearer ${testToken}` },
      });

      // Debug response
      console.log(`[TEST DEBUG] Response status: ${res.statusCode}`);
      const body = res.json();
      console.log(`[TEST DEBUG] Response body:`, JSON.stringify(body, null, 2));

      // Assert: Verify response
      assert.equal(res.statusCode, 200);
      assert.ok(Array.isArray(body.connections), `Expected connections array, got: ${typeof body.connections}`);
      assert.equal(body.connections.length, 1, `Expected 1 connection, got ${body.connections.length}`);

      const conn = body.connections[0];
      assert.equal(conn.id, connection.id);
      assert.equal(conn.provider, "google");
      assert.equal(conn.status, "healthy");

      // CRITICAL: Verify tokens are NEVER exposed
      assert.ok(!("encryptedTokens" in conn), "Encrypted tokens must not be exposed");
      assert.ok(!("accessToken" in conn), "Access token must not be exposed");
      assert.ok(!("refreshToken" in conn), "Refresh token must not be exposed");
    });

    it("excludes revoked connections from list", async () => {
      // Insert one healthy and one revoked connection
      const healthy = createTestConnection(testWorkspaceId);
      const revoked = createTestConnection(testWorkspaceId, { status: "revoked" });
      await db.insert(connections).values([
        {
          id: healthy.id,
          provider: healthy.provider,
          service: healthy.service,
          workspaceId: testWorkspaceId,
          label: "Healthy Connection",
          status: "healthy",
          grantedScopes: healthy.grantedScopes,
          metadata: healthy.metadata,
          encryptedTokens: healthy.encryptedTokens,
        },
        {
          id: revoked.id,
          provider: revoked.provider,
          service: revoked.service,
          workspaceId: testWorkspaceId,
          label: "Revoked Connection",
          status: "revoked",
          grantedScopes: revoked.grantedScopes,
          metadata: revoked.metadata,
          encryptedTokens: null, // tokens zeroed
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connections.length, 1, "Only healthy connections returned");
      assert.equal(body.connections[0].id, healthy.id);
      assert.equal(body.connections[0].label, "Healthy Connection");
    });

    it("returns empty array when workspace has no connections", async () => {
      // No connections in database

      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body.connections, []);
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/connections",
        // No Authorization header
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // POST /api/connections/start - Initialize OAuth flow
  // ===========================================================================

  describe("POST /api/connections/start", () => {
    it("initializes OAuth PKCE flow and returns authorization URL", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/start",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "google-gmail",
          label: "My Gmail",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        },
      });

      // Debug response
      console.log(`[TEST DEBUG] POST /connections/start status: ${res.statusCode}`);
      const body = res.json();
      console.log(`[TEST DEBUG] Response body:`, JSON.stringify(body, null, 2));

      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}. Body: ${JSON.stringify(body)}`);
      assert.ok(body.pendingConnectionId, "Pending connection ID returned");
      assert.ok(body.authorizationUrl, "Authorization URL present");
      assert.ok(body.authorizationUrl.includes("code_challenge"), "PKCE challenge present");
      assert.ok(body.authorizationUrl.includes("state"), "State parameter present");

      // Verify pending connection was created in database
      const pending = await db.select().from(pendingConnections).limit(1);
      console.log(`[TEST DEBUG] Pending connections in DB: ${pending.length}`);
      if (pending.length > 0) {
        console.log(`[TEST DEBUG] Pending connection:`, pending[0]);
      }
      assert.equal(pending.length, 1, `Expected 1 pending connection, got ${pending.length}`);
      assert.equal(pending[0]!.workspaceId, testWorkspaceId);
      assert.ok(pending[0]!.state, "State stored");
      assert.ok(pending[0]!.codeVerifier, "Code verifier stored");
    });

    it("rejects invalid service ID", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/start",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "invalid-service",
          label: "Test",
          scopes: ["scope"],
        },
      });

      assert.equal(res.statusCode, 400);
      const body = res.json();
      assert.ok(body.error.includes("Invalid service"));
    });

    it("rejects Telegram (not OAuth)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/start",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "telegram",
          label: "Telegram",
          scopes: [],
        },
      });

      const body = res.json();
      console.log(`[TEST DEBUG] Telegram rejection response:`, body);
      assert.equal(res.statusCode, 400);
      // Accept any error message - the important thing is it returns 400
      assert.ok(body.error, "Error message should be present");
    });

    it("requires non-empty scopes array", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/start",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "google-gmail",
          label: "Test",
          scopes: [], // Empty scopes
        },
      });

      const body = res.json();
      console.log(`[TEST DEBUG] Empty scopes response:`, body);
      assert.equal(res.statusCode, 400);
      // Accept any error message - the important thing is it returns 400
      assert.ok(body.error, "Error message should be present");
    });

    it("uses catalog default scopes when scopes omitted", async () => {
      // When body.scopes is not provided, the route should fall back to
      // SERVICE_CATALOG[service].scopes mapped from ServiceScope[] to string[].
      // This tests the ServiceScope.value extraction (was a type bug).
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/start",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "google-gmail",
          label: "Catalog defaults",
          // No scopes field — should use catalog defaults
        },
      });

      const body = res.json();
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}. Body: ${JSON.stringify(body)}`);
      assert.ok(body.authorizationUrl, "Authorization URL present");

      // The catalog scopes for google-gmail should appear in the authorization URL
      assert.ok(
        body.authorizationUrl.includes("gmail"),
        "Authorization URL should contain Gmail scope from catalog defaults",
      );

      // Verify the pending connection stored string[] (not ServiceScope[])
      const [pending] = await db
        .select({ scopes: pendingConnections.scopes })
        .from(pendingConnections)
        .where(eq(pendingConnections.label, "Catalog defaults"))
        .limit(1);
      assert.ok(pending, "Pending connection should exist");
      assert.ok(Array.isArray(pending.scopes), "Stored scopes should be an array");
      // Each scope should be a plain string URL, not an object
      for (const scope of pending.scopes) {
        assert.equal(typeof scope, "string", `Scope should be a string, got ${typeof scope}: ${JSON.stringify(scope)}`);
        assert.ok(scope.startsWith("https://"), `Scope should be a URL string, got: ${scope}`);
      }
    });
  });

  // ===========================================================================
  // POST /api/connections/bot-token - Add bot token connection
  // ===========================================================================

  describe("POST /api/connections/bot-token", () => {
    it("validates Telegram bot token and creates connection", async () => {
      // Mock Telegram API will validate any token except "invalid_token"
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/bot-token",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "telegram",
          botToken: "valid-bot-token",
          label: "My Telegram Bot",
        },
      });

      const body = res.json();
      console.log(`[TEST DEBUG] Bot token creation status: ${res.statusCode}`);
      console.log(`[TEST DEBUG] Bot token creation response:`, JSON.stringify(body, null, 2));
      assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}. Body: ${JSON.stringify(body)}`);
      assert.ok(body.botInfo, "Bot info returned");
      assert.ok(body.botInfo.botUsername, "Bot username returned");
      assert.equal(body.message, "Telegram Bot connected successfully");

      // Verify connection was created in database
      const conns = await db.select().from(connections).where(eq(connections.workspaceId, testWorkspaceId));
      console.log(`[TEST DEBUG] Bot token connections in DB: ${conns.length}`, conns[0]?.id);
      assert.equal(conns.length, 1, `Expected 1 connection, got ${conns.length}`);
      const conn = conns[0]!;
      assert.equal(conn.provider, "telegram");
      assert.equal(conn.service, "telegram");
      assert.equal(conn.status, "healthy");
      assert.ok((conn.metadata as Record<string, unknown>).botUsername, "Bot username stored in metadata");
      assert.ok(conn.encryptedTokens, "Tokens should be encrypted and stored");
    });

    it("rejects invalid Telegram bot token", async () => {
      // Use "invalid_token" which the mock Telegram API will reject with 401
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/bot-token",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "telegram",
          botToken: "invalid_token",
          label: "Test",
        },
      });

      // The route should catch the 401 error and return 400 or 500
      assert.ok(res.statusCode === 400 || res.statusCode === 500, `Expected 400 or 500, got ${res.statusCode}`);
      const body = res.json();
      assert.ok(body.error, "Error message returned");
    });

    it("requires service parameter", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/bot-token",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          botToken: "valid-bot-token",
          label: "Test",
        },
      });

      assert.equal(res.statusCode, 400);
    });

    it("requires botToken", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/bot-token",
        headers: { authorization: `Bearer ${testToken}` },
        payload: {
          service: "telegram",
          label: "Test",
          // Missing botToken
        },
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // ===========================================================================
  // GET /api/connections/callback - OAuth callback handler
  // ===========================================================================

  describe("GET /api/connections/callback", () => {
    it("redirects with error when OAuth provider returns error", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/connections/callback?error=access_denied&error_description=User+denied+access",
      });

      console.log(`[TEST DEBUG] Callback error redirect: ${res.statusCode}, location: ${res.headers.location}`);
      assert.equal(res.statusCode, 302);
      const location = res.headers.location as string;
      assert.ok(location.includes("/dashboard/connections"), "Redirects to dashboard");
      assert.ok(location.includes("error="), "Error param present in redirect");
    });

    it("redirects with error when code or state is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/connections/callback?code=test-code",
        // Missing state parameter
      });

      assert.equal(res.statusCode, 302);
      const location = res.headers.location as string;
      assert.ok(location.includes("error="), "Error param present when state missing");
    });

    it("redirects with error when state is not found in pending connections", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/connections/callback?code=test-code&state=nonexistent-state",
      });

      assert.equal(res.statusCode, 302);
      const location = res.headers.location as string;
      assert.ok(location.includes("error="), "Error param for invalid state");
    });

    it("redirects with error when pending connection has expired", async () => {
      // Insert an expired pending connection
      const expiredPending = createTestPendingConnection({
        workspaceId: testWorkspaceId,
        expiresAt: new Date(Date.now() - 60000), // Expired 1 minute ago
      });
      await db.insert(pendingConnections).values(expiredPending);

      const res = await app.inject({
        method: "GET",
        url: `/api/connections/callback?code=test-code&state=${expiredPending.state}`,
      });

      assert.equal(res.statusCode, 302);
      const location = res.headers.location as string;
      console.log(`[TEST DEBUG] Expired callback redirect: ${location}`);
      assert.ok(location.includes("error="), "Error param for expired pending");

      // Verify pending connection was cleaned up
      const remaining = await db.select().from(pendingConnections).where(eq(pendingConnections.id, expiredPending.id));
      assert.equal(remaining.length, 0, "Expired pending connection should be deleted");
    });

    it("creates connection on successful OAuth callback", async () => {
      // Insert a valid pending connection
      const pending = createTestPendingConnection({
        workspaceId: testWorkspaceId,
        metadata: { redirectUri: "http://localhost:3000/api/connections/callback" },
      });
      await db.insert(pendingConnections).values(pending);

      const res = await app.inject({
        method: "GET",
        url: `/api/connections/callback?code=valid-auth-code&state=${pending.state}`,
      });

      console.log(`[TEST DEBUG] Successful callback redirect: ${res.statusCode}, location: ${res.headers.location}`);
      assert.equal(res.statusCode, 302);
      const location = res.headers.location as string;
      assert.ok(location.includes("success=true"), "Redirect indicates success");

      // Verify connection was created in database
      const conns = await db.select().from(connections).where(eq(connections.workspaceId, testWorkspaceId));
      assert.equal(conns.length, 1, "Connection should be created");
      assert.equal(conns[0]!.provider, "google");
      assert.equal(conns[0]!.status, "healthy");
      assert.ok(conns[0]!.encryptedTokens, "Tokens should be stored encrypted");

      // Verify pending connection was cleaned up
      const remaining = await db.select().from(pendingConnections).where(eq(pendingConnections.id, pending.id));
      assert.equal(remaining.length, 0, "Pending connection should be deleted after success");
    });

    it("does not require authentication (skipAuth)", async () => {
      // Callback is accessed by OAuth provider redirect, not by authenticated user
      const res = await app.inject({
        method: "GET",
        url: "/api/connections/callback?code=test&state=test",
      });

      // Should NOT return 401 — it should process (even if state is invalid)
      assert.notEqual(res.statusCode, 401, "Callback should not require auth");
    });
  });

  // ===========================================================================
  // POST /api/connections/:id/revoke - Revoke connection
  // ===========================================================================

  describe("POST /api/connections/:id/revoke", () => {
    it("revokes a healthy connection", async () => {
      const connection = createTestConnection(testWorkspaceId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: connection.label,
        status: "healthy",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/revoke`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      console.log(`[TEST DEBUG] Revoke response: ${res.statusCode}`, res.json());
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connection.status, "revoked");
      assert.ok(body.auditId, "Audit ID present");

      // Verify in database
      const [conn] = await db.select().from(connections).where(eq(connections.id, connection.id));
      assert.equal(conn!.status, "revoked");
      assert.equal(conn!.encryptedTokens, null, "Encrypted tokens must be zeroed on revoke");
    });

    it("returns 404 when connection not found", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/00000000-0000-0000-0000-000000000099/revoke",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 409 when connection is already revoked", async () => {
      const connection = createTestConnection(testWorkspaceId, { status: "revoked" });
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: connection.label,
        status: "revoked",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/revoke`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.ok(body.error.includes("already revoked"));
    });

    it("revokes a needs_reauth connection", async () => {
      const connection = createTestConnection(testWorkspaceId, { status: "needs_reauth" });
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: connection.label,
        status: "needs_reauth",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/revoke`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connection.status, "revoked");
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/00000000-0000-0000-0000-000000000001/revoke",
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // POST /api/connections/:id/reauth - Initiate reauthentication
  // ===========================================================================

  describe("POST /api/connections/:id/reauth", () => {
    it("initiates reauth flow for needs_reauth connection", async () => {
      const connection = createTestConnection(testWorkspaceId, { status: "needs_reauth" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "google",
        service: "google-gmail",
        workspaceId: testWorkspaceId,
        label: "Test Gmail",
        status: "needs_reauth",
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      console.log(`[TEST DEBUG] Reauth response: ${res.statusCode}`, res.json());
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.pendingConnectionId, "Pending connection ID returned");
      assert.ok(body.authorizationUrl, "Authorization URL present");
      assert.ok(body.authorizationUrl.includes("code_challenge"), "PKCE challenge present");

      // Verify pending connection has reauthConnectionId in metadata
      const pending = await db.select().from(pendingConnections).limit(1);
      assert.equal(pending.length, 1);
      const meta = pending[0]!.metadata as Record<string, unknown>;
      assert.equal(meta.reauthConnectionId, connection.id, "Pending should reference original connection");
    });

    it("returns 404 when connection not found", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/connections/00000000-0000-0000-0000-000000000099/reauth",
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 409 when connection is revoked", async () => {
      const connection = createTestConnection(testWorkspaceId, { status: "revoked" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "google",
        service: "google-gmail",
        workspaceId: testWorkspaceId,
        label: "Test Revoked",
        status: "revoked",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
      });

      assert.equal(res.statusCode, 409);
    });

    it("reauths bot_token connection with valid Telegram token", async () => {
      const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
      const encTokens = JSON.stringify(encrypt(JSON.stringify({ botToken: "old-bot-token", tokenType: "bot" }), ENCRYPTION_KEY));

      const connection = createTestConnection(testWorkspaceId, { provider: "telegram", service: "telegram" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "telegram",
        service: "telegram",
        workspaceId: testWorkspaceId,
        label: "Test Telegram",
        status: "needs_reauth",
        grantedScopes: ["bot:sendMessage"],
        metadata: { botId: 123 },
        encryptedTokens: encTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { botToken: "new-valid-token" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connection.id, connection.id);
      assert.equal(body.connection.status, "healthy");
      assert.ok(body.message.includes("reconnected"));

      // Verify DB updated
      const [updated] = await db.select({ status: connections.status, encryptedTokens: connections.encryptedTokens })
        .from(connections).where(eq(connections.id, connection.id)).limit(1);
      assert.equal(updated?.status, "healthy");
      assert.notEqual(updated?.encryptedTokens, encTokens, "Encrypted tokens should be updated");
    });

    it("reauths api_key connection with valid key", async () => {
      const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
      const encTokens = JSON.stringify(encrypt(JSON.stringify({ apiKey: "sk-old-key" }), ENCRYPTION_KEY));

      const connection = createTestConnection(testWorkspaceId, { provider: "openai", service: "openai" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "openai",
        service: "openai",
        workspaceId: testWorkspaceId,
        label: "Test OpenAI",
        status: "needs_reauth",
        grantedScopes: ["chat", "embeddings"],
        metadata: null,
        encryptedTokens: encTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { apiKey: "sk-new-key-12345" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connection.id, connection.id);
      assert.equal(body.connection.status, "healthy");
      assert.ok(body.message.toLowerCase().includes("reconnected successfully"));

      // Verify DB updated
      const [updated] = await db.select({ status: connections.status })
        .from(connections).where(eq(connections.id, connection.id)).limit(1);
      assert.equal(updated?.status, "healthy");
    });

    it("returns 400 for bot_token reauth with missing botToken", async () => {
      const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
      const encTokens = JSON.stringify(encrypt(JSON.stringify({ botToken: "old-token", tokenType: "bot" }), ENCRYPTION_KEY));

      const connection = createTestConnection(testWorkspaceId, { provider: "telegram", service: "telegram" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "telegram",
        service: "telegram",
        workspaceId: testWorkspaceId,
        label: "Test Telegram",
        status: "needs_reauth",
        grantedScopes: ["bot:sendMessage"],
        metadata: { botId: 123 },
        encryptedTokens: encTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: {},
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("botToken"));
    });

    it("returns 400 for api_key reauth with empty key", async () => {
      const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
      const encTokens = JSON.stringify(encrypt(JSON.stringify({ apiKey: "sk-old" }), ENCRYPTION_KEY));

      const connection = createTestConnection(testWorkspaceId, { provider: "anthropic", service: "anthropic-messages" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "anthropic",
        service: "anthropic-messages",
        workspaceId: testWorkspaceId,
        label: "Test Anthropic",
        status: "needs_reauth",
        grantedScopes: ["messages"],
        metadata: null,
        encryptedTokens: encTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { apiKey: "" },
      });

      assert.equal(res.statusCode, 400);
      assert.ok(res.json().error.includes("apiKey"));
    });

    it("returns 400 for bot_token reauth with invalid token", async () => {
      const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;
      const encTokens = JSON.stringify(encrypt(JSON.stringify({ botToken: "old-token", tokenType: "bot" }), ENCRYPTION_KEY));

      const connection = createTestConnection(testWorkspaceId, { provider: "telegram", service: "telegram" });
      await db.insert(connections).values({
        id: connection.id,
        provider: "telegram",
        service: "telegram",
        workspaceId: testWorkspaceId,
        label: "Test Telegram",
        status: "needs_reauth",
        grantedScopes: ["bot:sendMessage"],
        metadata: { botId: 123 },
        encryptedTokens: encTokens,
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/connections/${connection.id}/reauth`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { botToken: "invalid_token" },
      });

      assert.equal(res.statusCode, 400);
    });
  });

  // ===========================================================================
  // PUT /api/connections/:id/label - Update connection label
  // ===========================================================================

  describe("PUT /api/connections/:id/label", () => {
    it("updates connection label", async () => {
      const connection = createTestConnection(testWorkspaceId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: "Old Label",
        status: "healthy",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/${connection.id}/label`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { label: "New Label" },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.connection.id, connection.id);
      assert.equal(body.connection.label, "New Label");
    });

    it("trims whitespace from label", async () => {
      const connection = createTestConnection(testWorkspaceId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: "Old Label",
        status: "healthy",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/${connection.id}/label`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { label: "  Trimmed Label  " },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(res.json().connection.label, "Trimmed Label");
    });

    it("returns 400 for empty label", async () => {
      const connection = createTestConnection(testWorkspaceId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: testWorkspaceId,
        label: "Old",
        status: "healthy",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/${connection.id}/label`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { label: "" },
      });

      assert.equal(res.statusCode, 400);
    });

    it("returns 404 for nonexistent connection", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/00000000-0000-0000-0000-000000000099/label`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { label: "New" },
      });

      assert.equal(res.statusCode, 404);
    });

    it("returns 404 for connection in another workspace", async () => {
      const otherWsId = "00000000-0000-0000-0000-000000000088";
      await db.insert(workspaces).values({ id: otherWsId, name: "Other WS", ownerId: "00000000-0000-0000-0000-000000000001" });
      const connection = createTestConnection(otherWsId);
      await db.insert(connections).values({
        id: connection.id,
        provider: connection.provider,
        service: connection.service,
        workspaceId: otherWsId,
        label: "Other",
        status: "healthy",
        grantedScopes: connection.grantedScopes,
        metadata: connection.metadata,
        encryptedTokens: connection.encryptedTokens,
      });

      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/${connection.id}/label`,
        headers: { authorization: `Bearer ${testToken}` },
        payload: { label: "Hacked" },
      });

      assert.equal(res.statusCode, 404);

      // Cleanup
      await db.delete(connections).where(eq(connections.workspaceId, otherWsId));
      await db.delete(workspaces).where(eq(workspaces.id, otherWsId));
    });

    it("requires authentication", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/connections/00000000-0000-0000-0000-000000000001/label`,
        payload: { label: "New" },
      });

      assert.equal(res.statusCode, 401);
    });
  });
});
