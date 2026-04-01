import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";

/**
 * Agent Auth Routes Tests with Real Test Database
 *
 * Tests the two unauthenticated endpoints:
 *   POST /agents/bootstrap — register/rotate public key with bootstrap secret
 *   POST /agents/token     — exchange signed assertion for access token
 *
 * Also tests jti replay protection end-to-end.
 */

// =============================================================================
// Imports
// =============================================================================
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer } from "../../test-helpers/mock-jwt.js";
import {
  createTestWorkspace,
  createTestAgent,
  createTestAgentKeyPair,
  createTestClientAssertion,
  createTestBootstrapSecret,
  createTestAccessToken,
} from "../../test-helpers/test-data.js";
import { db, sql } from "../../db/client.js";
import { eq } from "drizzle-orm";
import { workspaces } from "../../db/schema/workspaces.js";
import { agents } from "../../db/schema/agents.js";
import { agentBootstrapSecrets } from "../../db/schema/agent-bootstrap-secrets.js";
import { agentAccessTokens } from "../../db/schema/agent-access-tokens.js";
import { clearJtiCache } from "../../utils/jti-cache.js";

// =============================================================================
// Test suite
// =============================================================================

describe("Agent Auth Routes (Database Integrated)", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;
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

    const { default: agentAuthRoutes } = await import("../../routes/agent-auth.js");
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);
    await app.register(agentAuthRoutes, { prefix: "/api" });
    await app.ready();

    console.log(`[AGENT-AUTH TEST] Setup complete: workspace=${testWorkspaceId}`);
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  beforeEach(async () => {
    await clearJtiCache();
    await db.delete(agentAccessTokens).execute();
    await db.delete(agentBootstrapSecrets).execute();
    await db.delete(agents).where(eq(agents.workspaceId, testWorkspaceId));
  });

  // ===========================================================================
  // POST /api/agents/bootstrap
  // ===========================================================================

  describe("POST /api/agents/bootstrap", () => {
    it("bootstraps agent from created status (first enrollment)", async () => {
      const keyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      // Insert agent in "created" state
      const agent = createTestAgent(testWorkspaceId, { status: "created" });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.agentId, agent.id);
      assert.equal(body.status, "active");
      assert.equal(body.workspaceId, testWorkspaceId);

      // Verify agent is now active in DB
      const [updated] = await db
        .select({ status: agents.status, publicKeyJwk: agents.publicKeyJwk, enrolledAt: agents.enrolledAt })
        .from(agents)
        .where(eq(agents.id, agent.id));
      assert.equal(updated!.status, "active");
      assert.ok(updated!.publicKeyJwk);
      assert.ok(updated!.enrolledAt);
    });

    it("bootstraps active agent (key rotation, invalidates tokens)", async () => {
      const oldKeyPair = await createTestAgentKeyPair();
      const newKeyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: oldKeyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      // Insert an existing access token to verify it gets deleted
      const { hash: tokenHash } = createTestAccessToken();
      await db.insert(agentAccessTokens).values({
        agentId: agent.id,
        workspaceId: testWorkspaceId,
        tokenHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      });

      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: newKeyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.agentId, agent.id);
      assert.equal(body.status, "active");

      // Verify public key updated
      const [updated] = await db
        .select({ publicKeyJwk: agents.publicKeyJwk })
        .from(agents)
        .where(eq(agents.id, agent.id));
      assert.deepEqual(updated!.publicKeyJwk, newKeyPair.publicKey);

      // Verify old tokens deleted
      const tokens = await db
        .select()
        .from(agentAccessTokens)
        .where(eq(agentAccessTokens.agentId, agent.id));
      assert.equal(tokens.length, 0);
    });

    it("rejects bootstrap for disabled agent (409)", async () => {
      const keyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      const agent = createTestAgent(testWorkspaceId, {
        status: "disabled",
        disabledAt: new Date(),
      });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 409);
      assert.match(res.json().error, /disabled/);
    });

    it("rejects expired bootstrap secret", async () => {
      const keyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      const agent = createTestAgent(testWorkspaceId, { status: "created" });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() - 1000), // expired
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /Invalid or expired/);
    });

    it("rejects already-consumed secret (outside grace period)", async () => {
      const keyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      const agent = createTestAgent(testWorkspaceId, { status: "created" });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        consumedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // consumed 2h ago (outside 1h grace)
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("rejects invalid public key (not ES256)", async () => {
      const { secret, hash } = createTestBootstrapSecret();

      const agent = createTestAgent(testWorkspaceId, { status: "created" });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: { kty: "EC", crv: "P-384", x: "invalid", y: "invalid" },
        },
      });

      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /Invalid ES256/);
    });

    it("rejects wrong secret prefix", async () => {
      const keyPair = await createTestAgentKeyPair();

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: "bad_wrong_prefix",
          publicKey: keyPair.publicKey,
        },
      });

      assert.equal(res.statusCode, 401);
    });
  });

  // ===========================================================================
  // POST /api/agents/token
  // ===========================================================================

  describe("POST /api/agents/token", () => {
    it("issues access token for valid client assertion", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.ok(body.access_token.startsWith("ah5t_"), "Token should have ah5t_ prefix");
      assert.equal(body.token_type, "Bearer");
      assert.equal(body.expires_in, 7200);

      // Verify token stored in DB
      const tokens = await db
        .select()
        .from(agentAccessTokens)
        .where(eq(agentAccessTokens.agentId, agent.id));
      assert.equal(tokens.length, 1);
    });

    it("rejects assertion with wrong signature", async () => {
      const realKeyPair = await createTestAgentKeyPair();
      const wrongKeyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: realKeyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      // Sign with wrong key
      const assertion = await createTestClientAssertion(wrongKeyPair.privateKeyObj, agent.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /Invalid client assertion/);
    });

    it("rejects assertion with wrong audience", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id, {
        audience: "https://wrong-audience.example.com",
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("returns clock_skew reason for expired assertions", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id, {
        expiresInSeconds: -30,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.equal(res.json().reason, "clock_skew");
    });

    it("rejects jti replay (same assertion twice)", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const jti = randomUUID();
      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id, { jti });

      // First request — should succeed
      const res1 = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });
      assert.equal(res1.statusCode, 200);

      // Second request with same assertion (same jti) — should be rejected
      const res2 = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });
      assert.equal(res2.statusCode, 401);
      assert.match(res2.json().error, /[Rr]eplay/);
    });

    it("rejects token exchange for disabled agent", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "disabled",
        disabledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /not active/);
    });

    it("rejects assertion with lifetime > 60 seconds", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id, {
        expiresInSeconds: 120, // 2 minutes — exceeds 60s max
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /60 seconds/);
    });

    it("rejects nonexistent agent", async () => {
      const keyPair = await createTestAgentKeyPair();
      const fakeAgentId = randomUUID();

      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, fakeAgentId);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("rejects malformed assertion (not a JWT)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: "not.a.jwt",
        },
      });

      assert.equal(res.statusCode, 401);
    });

    it("rejects unsupported grant_type", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "password",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: "irrelevant",
        },
      });

      // Fastify schema validation catches invalid enum value before handler
      assert.ok(res.statusCode === 400 || res.statusCode === 401);
    });

    it("rejects assertion with missing jti", async () => {
      const keyPair = await createTestAgentKeyPair();

      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: keyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      // Sign a JWT without jti manually
      const { SignJWT } = await import("jose");
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer(agent.id)
        .setSubject(agent.id)
        .setAudience("http://localhost:4000")
        .setIssuedAt(now)
        .setExpirationTime(now + 30)
        // no setJti
        .sign(keyPair.privateKeyObj);

      const res = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });

      assert.equal(res.statusCode, 401);
      assert.match(res.json().error, /jti/);
    });
  });

  // ===========================================================================
  // Integration: bootstrap → token → verify token is valid
  // ===========================================================================

  describe("End-to-end: bootstrap → token", () => {
    it("completes full bootstrap and token exchange flow", async () => {
      const keyPair = await createTestAgentKeyPair();
      const { secret, hash } = createTestBootstrapSecret();

      // 1. Create agent
      const agent = createTestAgent(testWorkspaceId, { status: "created" });
      await db.insert(agents).values(agent);
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: hash,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      // 2. Bootstrap
      const bootstrapRes = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair.publicKey,
        },
      });
      assert.equal(bootstrapRes.statusCode, 200);
      assert.equal(bootstrapRes.json().status, "active");

      // 3. Exchange assertion for token
      const assertion = await createTestClientAssertion(keyPair.privateKeyObj, agent.id);
      const tokenRes = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: assertion,
        },
      });
      assert.equal(tokenRes.statusCode, 200);
      assert.ok(tokenRes.json().access_token.startsWith("ah5t_"));

      // 4. Within 1-hour grace period, re-bootstrap is allowed (retry-friendly)
      const keyPair2 = await createTestAgentKeyPair();
      const bootstrapRes2 = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret: secret,
          publicKey: keyPair2.publicKey,
        },
      });
      assert.equal(bootstrapRes2.statusCode, 200); // grace period allows re-use
    });

    it("re-bootstrap invalidates old tokens and allows new auth", async () => {
      const oldKeyPair = await createTestAgentKeyPair();
      const newKeyPair = await createTestAgentKeyPair();
      const { secret: bootstrapSecret, hash: bootstrapHash } = createTestBootstrapSecret();

      // Setup active agent with old key
      const agent = createTestAgent(testWorkspaceId, {
        status: "active",
        enrolledAt: new Date(),
        publicKeyJwk: oldKeyPair.publicKey as unknown as Record<string, unknown>,
      });
      await db.insert(agents).values(agent);

      // Get a token with old key
      const oldAssertion = await createTestClientAssertion(oldKeyPair.privateKeyObj, agent.id);
      const oldTokenRes = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: oldAssertion,
        },
      });
      assert.equal(oldTokenRes.statusCode, 200);

      // Re-bootstrap with new key
      await db.insert(agentBootstrapSecrets).values({
        agentId: agent.id,
        type: "bootstrap",
        secretHash: bootstrapHash,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      const bootstrapRes = await app.inject({
        method: "POST",
        url: "/api/agents/bootstrap",
        payload: {
          bootstrapSecret,
          publicKey: newKeyPair.publicKey,
        },
      });
      assert.equal(bootstrapRes.statusCode, 200);

      // Old key should fail
      const staleAssertion = await createTestClientAssertion(oldKeyPair.privateKeyObj, agent.id);
      const staleRes = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: staleAssertion,
        },
      });
      assert.equal(staleRes.statusCode, 401);

      // New key should succeed
      const newAssertion = await createTestClientAssertion(newKeyPair.privateKeyObj, agent.id);
      const newTokenRes = await app.inject({
        method: "POST",
        url: "/api/agents/token",
        payload: {
          grant_type: "client_assertion",
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          client_assertion: newAssertion,
        },
      });
      assert.equal(newTokenRes.statusCode, 200);
      assert.ok(newTokenRes.json().access_token.startsWith("ah5t_"));
    });
  });
});
