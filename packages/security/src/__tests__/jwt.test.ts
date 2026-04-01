import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, type KeyLike } from "jose";
import { signJwt, verifyJwt, type JwtClaims } from "../jwt.ts";

const TEST_ISSUER = "https://auth.agenthifive.dev";
const TEST_AUDIENCE = "api";

describe("jwt", () => {
  let privateKey: KeyLike;
  let publicKey: KeyLike;
  let jwksServer: Server;
  let jwksUrl: string;

  before(async () => {
    // Generate an RSA key pair for testing
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;

    // Export public key as JWK and serve it via a local HTTP server
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key-1";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    const jwks = JSON.stringify({ keys: [publicJwk] });

    jwksServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(jwks);
    });

    await new Promise<void>((resolve) => {
      jwksServer.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = jwksServer.address();
    if (addr && typeof addr === "object") {
      jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;
    }
  });

  after(() => {
    jwksServer.close();
  });

  it("signs and verifies a JWT round-trip", async () => {
    const claims: JwtClaims = {
      sub: "user-123",
      wid: "ws-456",
      roles: ["owner"],
      scp: ["connections:read", "connections:write"],
      sid: "session-789",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });

    assert.ok(typeof token === "string");
    assert.ok(token.split(".").length === 3, "JWT has 3 parts");

    const verified = await verifyJwt(token, jwksUrl, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });

    assert.equal(verified.sub, "user-123");
    assert.equal(verified.wid, "ws-456");
    assert.deepEqual(verified.roles, ["owner"]);
    assert.deepEqual(verified.scp, ["connections:read", "connections:write"]);
    assert.equal(verified.sid, "session-789");
  });

  it("includes iat, nbf, and exp claims with 5-minute default TTL", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: ["member"],
      scp: [],
      sid: "s-1",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const verified = await verifyJwt(token, jwksUrl, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });

    assert.ok(typeof verified.iat === "number");
    assert.ok(typeof verified.nbf === "number");
    assert.ok(typeof verified.exp === "number");

    const ttl = verified.exp! - verified.iat!;
    assert.equal(ttl, 300, "Default TTL should be 5 minutes (300s)");
    assert.equal(verified.nbf, verified.iat, "nbf should equal iat");
  });

  it("supports custom TTL", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: ["member"],
      scp: [],
      sid: "s-1",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      ttl: 60,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const verified = await verifyJwt(token, jwksUrl, {
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });

    const ttl = verified.exp! - verified.iat!;
    assert.equal(ttl, 60, "Custom TTL should be 60s");
  });

  it("rejects a tampered token", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: ["owner"],
      scp: [],
      sid: "s-1",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });
    const tampered = token.slice(0, -5) + "XXXXX";

    await assert.rejects(
      () => verifyJwt(tampered, jwksUrl),
      /signature/i,
    );
  });

  it("rejects an expired token", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: [],
      scp: [],
      sid: "s-1",
    };

    // Sign with 0-second TTL (already expired)
    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      ttl: 0,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
    });

    // Wait a tick for expiration
    await new Promise((r) => setTimeout(r, 1100));

    await assert.rejects(
      () => verifyJwt(token, jwksUrl),
      /expired|"exp" claim/i,
    );
  });

  it("rejects a token with wrong issuer", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: [],
      scp: [],
      sid: "s-1",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      issuer: "https://wrong.issuer.com",
      audience: TEST_AUDIENCE,
    });

    await assert.rejects(
      () => verifyJwt(token, jwksUrl, { issuer: TEST_ISSUER }),
      /issuer|"iss" claim/i,
    );
  });

  it("rejects a token with wrong audience", async () => {
    const claims: JwtClaims = {
      sub: "user-1",
      wid: "ws-1",
      roles: [],
      scp: [],
      sid: "s-1",
    };

    const token = await signJwt(claims, privateKey, {
      kid: "test-key-1",
      issuer: TEST_ISSUER,
      audience: "wrong-audience",
    });

    await assert.rejects(
      () => verifyJwt(token, jwksUrl, { audience: TEST_AUDIENCE }),
      /audience|"aud" claim/i,
    );
  });
});
