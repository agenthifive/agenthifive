import { describe, it, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Credential Resolve Route Tests with Real Test Database
 *
 * Tests POST /credentials/resolve — the endpoint that the OpenClaw fork's
 * VaultCredentialProvider calls to fetch API keys, OAuth tokens, or bot tokens.
 *
 * Setup: docker-compose.test.yml starts postgres on port 5433
 * Run: cd apps/api && bash run-tests.sh
 */

// =============================================================================
// STEP 0: Set environment variables BEFORE any imports
// =============================================================================

process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.GOOGLE_CLIENT_ID = "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.MICROSOFT_CLIENT_ID = "test-ms-client-id";
process.env.MICROSOFT_CLIENT_SECRET = "test-ms-client-secret";

// =============================================================================
// STEP 1: Mock external dependencies
// =============================================================================

const mockGoogleRefreshFn = mock.fn(async () => ({
  accessToken: "mock_refreshed_access_token",
  refreshToken: "mock_new_refresh_token",
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
}));

const mockMsRefreshFn = mock.fn(async () => ({
  accessToken: "mock_ms_refreshed_token",
  refreshToken: "mock_ms_new_refresh_token",
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
}));

const MockGoogleConnector = mock.fn(function (this: any) {
  this.refresh = mockGoogleRefreshFn;
  this.capabilities = mock.fn(() => ({ provider: "google", supportsAuthCode: true }));
});

const MockMicrosoftConnector = mock.fn(function (this: any) {
  this.refresh = mockMsRefreshFn;
  this.capabilities = mock.fn(() => ({ provider: "microsoft", supportsAuthCode: true }));
});

const MockTelegramBotProvider = mock.fn(function (this: any) {
  this.validateBotToken = mock.fn(async () => ({ id: 123456789, isBot: true }));
});

mock.module("@agenthifive/oauth-connectors", {
  namedExports: {
    GoogleConnector: MockGoogleConnector,
    MicrosoftConnector: MockMicrosoftConnector,
    TelegramBotProvider: MockTelegramBotProvider,
  },
});

// =============================================================================
// STEP 2: Import dependencies (AFTER mocking)
// =============================================================================

import { createHash } from "node:crypto";
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import { db, sql } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { connections } from "../../db/schema/connections.js";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { auditEvents } from "../../db/schema/audit-events.js";
import { encrypt } from "@agenthifive/security";

// =============================================================================
// Helpers
// =============================================================================

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY!;

function encryptTokens(tokens: Record<string, unknown>): string {
  return JSON.stringify(encrypt(JSON.stringify(tokens), ENCRYPTION_KEY));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// STEP 3: Test suite
// =============================================================================

describe("Credential Resolve Routes [DB Integrated]", { concurrency: 1 }, () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
  let testToken: string;
  const testWorkspaceId = "c0ed0000-0000-0000-0000-000000000001";
  const testUserId = "user-cred-test";

  before(async () => {
    mockJwks = await createMockJwksServer();
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Warm up DB pool
    await db.select({ id: workspaces.id }).from(workspaces).limit(1);
    await sql`SELECT 1`;

    // Create test workspace
    await db.insert(workspaces).values({
      id: testWorkspaceId,
      name: "Credential Test Workspace",
      ownerId: "c0ed0000-0000-0000-0000-000000000099",
    }).onConflictDoNothing();
    console.log(`[CRED TEST SETUP] Workspace ${testWorkspaceId} ready`);

    // Create test JWT
    testToken = await mockJwks.createTestJwt({
      sub: testUserId,
      wid: testWorkspaceId,
      roles: ["owner"],
      scp: ["vault:execute"],
      sid: "c0ed0000-0000-0000-0000-eeeeeeeeeeee",
    });

    // Import credential routes AFTER setting ENCRYPTION_KEY
    const { default: credentialRoutes } = await import("../../routes/credentials.js");

    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(credentialRoutes);
    await app.ready();
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
  });

  beforeEach(async () => {
    // Reset mocks
    mockGoogleRefreshFn.mock.resetCalls();
    mockGoogleRefreshFn.mock.mockImplementation(async () => ({
      accessToken: "mock_refreshed_access_token",
      refreshToken: "mock_new_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));
    mockMsRefreshFn.mock.resetCalls();
    mockMsRefreshFn.mock.mockImplementation(async () => ({
      accessToken: "mock_ms_refreshed_token",
      refreshToken: "mock_ms_new_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    }));

    // Clean test data
    await sql.begin(async (tx: any) => {
      await tx`DELETE FROM l_audit_events WHERE connection_id IN (
        SELECT id FROM t_connections WHERE workspace_id = ${testWorkspaceId}
      )`;
      await tx`DELETE FROM l_audit_events WHERE actor = ${testUserId}`;
      await tx`DELETE FROM l_audit_events WHERE actor LIKE 'agent:%'`;
      await tx`DELETE FROM t_policies WHERE connection_id IN (
        SELECT id FROM t_connections WHERE workspace_id = ${testWorkspaceId}
      )`;
      await tx`DELETE FROM t_connections WHERE workspace_id = ${testWorkspaceId}`;
      await tx`DELETE FROM t_agent_access_tokens WHERE workspace_id = ${testWorkspaceId}`;
      await tx`DELETE FROM t_agents WHERE workspace_id = ${testWorkspaceId}`;
    });
  });

  // =========================================================================
  // Group 1: Happy Paths
  // =========================================================================

  it("returns access token after refreshing expired Google OAuth token", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000010";
    const encTokens = encryptTokens({
      accessToken: "old_expired_token",
      refreshToken: "valid_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // expired 1h ago
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Test Gmail', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://www.googleapis.com/auth/gmail.readonly"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.apiKey, "mock_refreshed_access_token");
    assert.equal(body.mode, "oauth");
    assert.ok(body.source.startsWith("vault:google:"));
    assert.ok(body.cacheTtlMs >= 30_000 && body.cacheTtlMs <= 300_000, `cacheTtlMs ${body.cacheTtlMs} in range`);
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 1);
  });

  it("returns Telegram bot token directly without refresh", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000011";
    const encTokens = encryptTokens({
      botToken: "bot123:secret_token",
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'telegram', 'telegram', 'Test Telegram Bot', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["bot:sendMessage"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "telegram" },
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.apiKey, "bot123:secret_token");
    assert.equal(body.mode, "token");
    assert.equal(body.cacheTtlMs, 300_000);
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 0);
  });

  it("resolves by connection UUID when profileId is provided", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000012";
    const freshToken = "fresh_valid_access_token";
    const encTokens = encryptTokens({
      accessToken: freshToken,
      refreshToken: "some_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1h from now
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'UUID Lookup Gmail', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://www.googleapis.com/auth/gmail.readonly"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google", profileId: connId },
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.apiKey, freshToken);
    assert.equal(body.mode, "oauth");
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 0);
  });

  // =========================================================================
  // Group 2: Token Refresh
  // =========================================================================

  it("refreshes expired token automatically", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000020";
    const encTokens = encryptTokens({
      accessToken: "stale_token",
      refreshToken: "valid_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Expired Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "mock_refreshed_access_token");
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 1);
  });

  it("proactively refreshes token expiring within 60 seconds", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000021";
    const encTokens = encryptTokens({
      accessToken: "about_to_expire_token",
      refreshToken: "valid_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 30_000).toISOString(), // 30s from now
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Near-Expiry Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "mock_refreshed_access_token");
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 1);
  });

  it("uses Microsoft connector for msteams provider refresh", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000022";
    const encTokens = encryptTokens({
      accessToken: "expired_ms_token",
      refreshToken: "ms_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'microsoft', 'microsoft-teams', 'Test Teams', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://graph.microsoft.com/.default"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "msteams" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "mock_ms_refreshed_token");
    assert.equal(mockMsRefreshFn.mock.callCount(), 1);
    assert.equal(mockGoogleRefreshFn.mock.callCount(), 0);
  });

  // =========================================================================
  // Group 3: Provider Mapping
  // =========================================================================

  it("maps msteams to Microsoft provider with microsoft-teams service filter", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000030";
    const encTokens = encryptTokens({
      accessToken: "ms_teams_token",
      refreshToken: "ms_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'microsoft', 'microsoft-teams', 'Teams Connection', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://graph.microsoft.com/.default"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "msteams" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "ms_teams_token");
  });

  it("finds any Google connection regardless of service when no service filter", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000031";
    const encTokens = encryptTokens({
      accessToken: "google_drive_token",
      refreshToken: "gdrive_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-drive', 'Google Drive', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://www.googleapis.com/auth/drive"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "google_drive_token");
  });

  // =========================================================================
  // Group 4: Extra Fields
  // =========================================================================

  it("includes tenantId in extra for MS Teams connections", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000040";
    const encTokens = encryptTokens({
      accessToken: "ms_token_with_tenant",
      refreshToken: "ms_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes, metadata)
      VALUES (${connId}, 'microsoft', 'microsoft-teams', 'Teams with Tenant', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["https://graph.microsoft.com/.default"])},
              ${JSON.stringify({ tenantId: "tenant-abc-123" })}::jsonb)
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "msteams" },
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.extra?.tenantId, "tenant-abc-123");
  });

  it("includes appToken in extra when present in metadata", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000041";
    const encTokens = encryptTokens({
      accessToken: "google_token_with_extra",
      refreshToken: "google_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes, metadata)
      VALUES (${connId}, 'google', 'google-gmail', 'Gmail with AppToken', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])},
              ${JSON.stringify({ appToken: "xapp-token-123" })}::jsonb)
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    const body = res.json();
    assert.equal(res.statusCode, 200);
    assert.equal(body.extra?.appToken, "xapp-token-123");
  });

  // =========================================================================
  // Group 5: 404 Cases
  // =========================================================================

  it("returns 404 for unknown provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "model_provider", provider: "unknown_provider" },
    });

    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error.includes("No credential found"));
  });

  it("returns 404 when no connections exist for valid provider", async () => {
    // No connections inserted in beforeEach cleanup
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
  });

  it("returns 404 when connection belongs to different workspace", async () => {
    const otherWorkspaceId = "c0ed0000-0000-0000-0000-000000000999";
    await db.insert(workspaces).values({
      id: otherWorkspaceId,
      name: "Other Workspace",
      ownerId: "c0ed0000-0000-0000-0000-000000000098",
    }).onConflictDoNothing();

    const connId = "c0ed0000-0000-0000-0000-000000000050";
    const encTokens = encryptTokens({
      accessToken: "other_ws_token",
      refreshToken: "other_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Other WS Gmail', 'healthy',
              ${otherWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
  });

  it("returns 404 for non-existent UUID profileId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: {
        kind: "model_provider",
        provider: "google",
        profileId: "00000000-0000-0000-0000-000000000099",
      },
    });

    assert.equal(res.statusCode, 404);
  });

  // =========================================================================
  // Group 6: Connection Status Errors
  // =========================================================================

  it("returns 404 when connection is revoked (by-name lookup requires healthy)", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000060";
    const encTokens = encryptTokens({
      accessToken: "revoked_token",
      refreshToken: "revoked_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Revoked Gmail', 'revoked',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
  });

  it("returns 404 when connection needs reauth (by-name lookup requires healthy)", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000061";
    const encTokens = encryptTokens({
      accessToken: "stale_token",
      refreshToken: "stale_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Needs Reauth Gmail', 'needs_reauth',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
  });

  it("returns 404 and marks needs_reauth when no refresh token available", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000062";
    const encTokens = encryptTokens({
      accessToken: "expired_no_refresh",
      refreshToken: null,
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'No Refresh Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error.includes("reauthentication"));

    // Wait for async markConnectionNeedsReauth
    await delay(50);
    const [conn] = await db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connId))
      .limit(1);
    assert.equal(conn?.status, "needs_reauth");
  });

  // =========================================================================
  // Group 7: Refresh Failure
  // =========================================================================

  it("returns 404 and marks needs_reauth when OAuth refresh throws", async () => {
    mockGoogleRefreshFn.mock.mockImplementation(async () => {
      throw new Error("invalid_grant: Token has been expired or revoked");
    });

    const connId = "c0ed0000-0000-0000-0000-000000000070";
    const encTokens = encryptTokens({
      accessToken: "expired_token",
      refreshToken: "bad_refresh_token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Bad Refresh', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 404);
    assert.ok(res.json().error.includes("reauthentication"));

    await delay(50);
    const [conn] = await db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connId))
      .limit(1);
    assert.equal(conn?.status, "needs_reauth");
  });

  it("returns fresh token when refresh succeeds", async () => {
    mockGoogleRefreshFn.mock.mockImplementation(async () => ({
      accessToken: "brand_new_token",
      refreshToken: "updated_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    }));

    const connId = "c0ed0000-0000-0000-0000-000000000071";
    const encTokens = encryptTokens({
      accessToken: "old_token",
      refreshToken: "valid_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Refresh Success', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "brand_new_token");
  });

  // =========================================================================
  // Group 8: Encryption Errors
  // =========================================================================

  it("returns 500 when encrypted tokens are corrupt", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000080";

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Corrupt Tokens', 'healthy',
              ${testWorkspaceId}, 'not-valid-json-at-all', ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 500);
    assert.ok(res.json().error.toLowerCase().includes("decrypt"));
  });

  it("returns 500 when Telegram connection is missing botToken", async () => {
    const connId = "c0ed0000-0000-0000-0000-000000000081";
    const encTokens = encryptTokens({
      accessToken: "not_a_bot_token",
      // no botToken field
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'telegram', 'telegram', 'Missing Bot Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["bot:sendMessage"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "telegram" },
    });

    assert.equal(res.statusCode, 500);
    assert.ok(res.json().error.toLowerCase().includes("bot token"));
  });

  // =========================================================================
  // Group 9: Request Validation
  // =========================================================================

  it("returns 400 when kind is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { provider: "google" },
    });

    assert.equal(res.statusCode, 400);
  });

  it("returns 400 when provider is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "model_provider" },
    });

    assert.equal(res.statusCode, 400);
  });

  // =========================================================================
  // Group 10: Authentication
  // =========================================================================

  it("returns 401 when no auth header is provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 401);
  });

  it("returns 401 for invalid JWT", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: "Bearer invalid.jwt.garbage" },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 401);
  });

  // =========================================================================
  // Group 11: Audit Logging
  // =========================================================================

  it("creates audit event for Google OAuth credential resolve", async () => {
    const connId = "c0ed0000-0000-0000-0000-0000000000a0";
    const encTokens = encryptTokens({
      accessToken: "audit_test_token",
      refreshToken: "audit_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Audit Test Gmail', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    // Wait for fire-and-forget audit write
    await delay(100);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.connectionId, connId));

    assert.ok(rows.length >= 1, `Expected at least 1 audit event, got ${rows.length}`);
    const event = rows.find((r) => r.action === "credential_resolved");
    assert.ok(event, "credential_resolved audit event exists");
    assert.equal(event!.decision, "allowed");
    const meta = event!.metadata as Record<string, unknown>;
    assert.equal(meta.mode, "oauth");
    assert.equal(meta.provider, "google");
  });

  it("creates audit event with mode=token for Telegram resolve", async () => {
    const connId = "c0ed0000-0000-0000-0000-0000000000a1";
    const encTokens = encryptTokens({
      botToken: "audit_bot_token",
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'telegram', 'telegram', 'Audit Telegram Bot', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["bot:sendMessage"])})
    `;

    await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "telegram" },
    });

    await delay(100);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.connectionId, connId));

    const event = rows.find((r) => r.action === "credential_resolved");
    assert.ok(event, "credential_resolved audit event exists");
    const meta = event!.metadata as Record<string, unknown>;
    assert.equal(meta.mode, "token");
  });

  // =========================================================================
  // Group 12: Cache TTL Calculation
  // =========================================================================

  it("caps cacheTtlMs at 300000 for long-lived tokens", async () => {
    const connId = "c0ed0000-0000-0000-0000-0000000000b0";
    const encTokens = encryptTokens({
      accessToken: "long_lived_token",
      refreshToken: "long_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 86400_000).toISOString(), // 24h from now
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Long-lived Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cacheTtlMs, 300_000);
  });

  it("floors cacheTtlMs at 30000 for short-lived tokens", async () => {
    const connId = "c0ed0000-0000-0000-0000-0000000000b1";
    const encTokens = encryptTokens({
      accessToken: "short_lived_token",
      refreshToken: "short_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 61_000).toISOString(), // 61s from now → 61-60=1s → floored to 30s
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Short-lived Token', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().cacheTtlMs, 30_000);
  });

  // =========================================================================
  // Group 13: Agent Access Token — Blocked from raw credential vending
  // =========================================================================

  const testAgentToken = "ah5t_test-agent-token-for-credentials";
  const testAgentTokenHash = createHash("sha256").update(testAgentToken).digest("hex");
  const testAgentId = "c0ed0000-0000-0000-0000-0000000000c0";
  const testAgentTokenId = "c0ed0000-0000-0000-0000-0000000000c9";

  it("returns 403 when agent tries to resolve channel credentials", async () => {
    await sql`
      INSERT INTO t_agents (id, name, workspace_id, status)
      VALUES (${testAgentId}, 'Test Agent', ${testWorkspaceId}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO t_agent_access_tokens (id, agent_id, workspace_id, token_hash, expires_at)
      VALUES (${testAgentTokenId}, ${testAgentId}, ${testWorkspaceId}, ${testAgentTokenHash}, ${new Date(Date.now() + 3600_000).toISOString()})
      ON CONFLICT (id) DO NOTHING
    `;

    const connId = "c0ed0000-0000-0000-0000-0000000000c1";
    const encTokens = encryptTokens({
      accessToken: "agent_access_token",
      refreshToken: "agent_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Agent Google', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { "x-api-key": testAgentToken },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 403);
    assert.ok(res.json().error.includes("Agents cannot access credentials/resolve directly"));
    assert.ok(res.json().hint.includes("vault/execute"));
  });

  it("returns 403 when agent tries to resolve model_provider credentials", async () => {
    await sql`
      INSERT INTO t_agents (id, name, workspace_id, status)
      VALUES (${testAgentId}, 'Test Agent', ${testWorkspaceId}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO t_agent_access_tokens (id, agent_id, workspace_id, token_hash, expires_at)
      VALUES (${testAgentTokenId}, ${testAgentId}, ${testWorkspaceId}, ${testAgentTokenHash}, ${new Date(Date.now() + 3600_000).toISOString()})
      ON CONFLICT (id) DO NOTHING
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { "x-api-key": testAgentToken },
      payload: { kind: "model_provider", provider: "openai" },
    });

    assert.equal(res.statusCode, 403);
    assert.ok(res.json().error.includes("Agents cannot access credentials/resolve directly"));
  });

  it("returns 401 for invalid agent access token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { "x-api-key": "ah5t_this-token-does-not-exist" },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 401);
    assert.ok(res.json().error.includes("Invalid"));
  });

  it("does not create audit events when agent is blocked", async () => {
    await sql`
      INSERT INTO t_agents (id, name, workspace_id, status)
      VALUES (${testAgentId}, 'Test Agent', ${testWorkspaceId}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO t_agent_access_tokens (id, agent_id, workspace_id, token_hash, expires_at)
      VALUES (${testAgentTokenId}, ${testAgentId}, ${testWorkspaceId}, ${testAgentTokenHash}, ${new Date(Date.now() + 3600_000).toISOString()})
      ON CONFLICT (id) DO NOTHING
    `;

    const connId = "c0ed0000-0000-0000-0000-0000000000c2";
    const encTokens = encryptTokens({
      accessToken: "agent_audit_token",
      refreshToken: "agent_audit_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Agent Audit Google', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { "x-api-key": testAgentToken },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 403);

    await delay(100);

    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.connectionId, connId));

    assert.equal(rows.length, 0, "No audit events should be created for blocked agent requests");
  });

  // =========================================================================
  // Group 14: User JWT still works (admin/dashboard access preserved)
  // =========================================================================

  it("user JWT can still resolve credentials (admin access)", async () => {
    const connId = "c0ed0000-0000-0000-0000-0000000000d0";
    const encTokens = encryptTokens({
      accessToken: "admin_access_token",
      refreshToken: "admin_refresh",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    await sql`
      INSERT INTO t_connections (id, provider, service, label, status, workspace_id, encrypted_tokens, granted_scopes)
      VALUES (${connId}, 'google', 'google-gmail', 'Admin Google', 'healthy',
              ${testWorkspaceId}, ${encTokens}, ${sql.array(["email"])})
    `;

    const res = await app.inject({
      method: "POST",
      url: "/credentials/resolve",
      headers: { authorization: `Bearer ${testToken}` },
      payload: { kind: "channel", provider: "google" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().apiKey, "admin_access_token");
    assert.equal(res.json().mode, "oauth");
  });

}); // end describe
