import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import jwtAuthPlugin from "../../plugins/jwt-auth.js";
import { createMockJwksServer, createExpiredJwt, createTamperedJwt } from "../../test-helpers/mock-jwt.js";

describe("JWT Auth Middleware", () => {
  let app: FastifyInstance;
  let mockJwks: Awaited<ReturnType<typeof createMockJwksServer>>;

  before(async () => {
    // Create mock JWKS server
    mockJwks = await createMockJwksServer();

    // Set JWKS URL env var
    process.env.WEB_JWKS_URL = mockJwks.jwksUrl;

    // Create Fastify app with JWT auth plugin
    app = Fastify({ logger: false });
    await app.register(jwtAuthPlugin);

    // Register test routes
    app.get("/protected", async (request) => {
      return { user: request.user };
    });

    app.get("/public", { config: { skipAuth: true } }, async () => {
      return { message: "public endpoint" };
    });

    await app.ready();
  });

  after(async () => {
    await app.close();
    await mockJwks.close();
    delete process.env.WEB_JWKS_URL;
  });

  it("allows access with valid JWT", async () => {
    const token = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: ["connections:read"],
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.user.sub, "user-123");
    assert.equal(body.user.wid, "workspace-456");
    assert.deepEqual(body.user.roles, ["owner"]);
    assert.deepEqual(body.user.scp, ["connections:read"]);
    assert.equal(body.user.sid, "session-789");
  });

  it("returns 401 when Authorization header missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Missing Authorization header, X-API-Key, or X-Goog-Api-Key"));
  });

  it("returns 401 when Authorization header has wrong format", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: "InvalidFormat token123",
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Missing Authorization header, X-API-Key, or X-Goog-Api-Key"));
  });

  it("returns 401 when token is expired", async () => {
    const expiredToken = await createExpiredJwt(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });

  it("returns 401 when token signature is invalid", async () => {
    const tamperedToken = await createTamperedJwt(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${tamperedToken}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });

  it("returns 401 when required claim 'sub' is missing", async () => {
    const token = await mockJwks.createTestJwt({
      sub: undefined, // Missing sub
      wid: "workspace-456",
      roles: ["owner"],
      scp: ["connections:read"],
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid JWT claims"));
  });

  it("returns 401 when required claim 'wid' is missing", async () => {
    const token = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: undefined, // Missing wid
      roles: ["owner"],
      scp: ["connections:read"],
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid JWT claims"));
  });

  it("returns 401 when 'roles' is not an array", async () => {
    const token = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: "workspace-456",
      roles: "owner", // Should be array, not string
      scp: ["connections:read"],
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid JWT claims"));
  });

  it("returns 401 when 'scp' is not an array", async () => {
    const token = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: "connections:read", // Should be array, not string
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid JWT claims"));
  });

  it("bypasses auth for routes with skipAuth: true", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/public",
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.message, "public endpoint");
  });

  it("allows empty arrays for roles and scp", async () => {
    const token = await mockJwks.createTestJwt({
      sub: "user-123",
      wid: "workspace-456",
      roles: [], // Empty array is valid
      scp: [], // Empty array is valid
      sid: "session-789",
    });

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.user.roles, []);
    assert.deepEqual(body.user.scp, []);
  });

  // ── Issuer + audience validation (security hardening) ─────────────

  it("returns 401 when JWT has wrong issuer", async () => {
    const claims = {
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: ["connections:read"],
      sid: "session-789",
    };

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("5m")
      .setIssuer("https://evil.example.com") // Wrong issuer
      .setAudience("api")
      .sign(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });

  it("returns 401 when JWT has wrong audience", async () => {
    const claims = {
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: ["connections:read"],
      sid: "session-789",
    };

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("5m")
      .setIssuer("http://localhost:3000") // Correct issuer
      .setAudience("wrong-audience") // Wrong audience
      .sign(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });

  it("returns 401 when JWT is missing issuer claim entirely", async () => {
    const claims = {
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: [],
      sid: "s-1",
    };

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setAudience("api")
      // No setIssuer() — missing issuer
      .sign(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });

  it("returns 401 when JWT is missing audience claim entirely", async () => {
    const claims = {
      sub: "user-123",
      wid: "workspace-456",
      roles: ["owner"],
      scp: [],
      sid: "s-1",
    };

    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .setIssuer("http://localhost:3000")
      // No setAudience() — missing audience
      .sign(mockJwks.privateKey);

    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes("Invalid or expired token"));
  });
});
