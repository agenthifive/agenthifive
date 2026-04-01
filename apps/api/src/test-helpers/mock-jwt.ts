import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from "jose";
import { createTestJwtClaims } from "./test-data.js";

export interface MockJwksServer {
  /** HTTP server instance */
  server: Server;
  /** JWKS endpoint URL */
  jwksUrl: string;
  /** Private key for signing JWTs */
  privateKey: KeyLike;
  /** Create a signed JWT with the given claims */
  createTestJwt: (claims?: Record<string, unknown>) => Promise<string>;
  /** Stop the JWKS server */
  close: () => Promise<void>;
}

/**
 * Creates a mock JWKS server for testing JWT authentication
 *
 * The server:
 * - Generates an RSA keypair
 * - Serves the public key as JWKS at /.well-known/jwks.json
 * - Provides a helper to create signed JWTs
 *
 * Based on pattern from packages/security/src/__tests__/jwt.test.ts
 *
 * @example
 * const mock = await createMockJwksServer();
 * const token = await mock.createTestJwt({ sub: 'user-123', wid: 'workspace-456' });
 * // ... test with token ...
 * await mock.close();
 */
export async function createMockJwksServer(): Promise<MockJwksServer> {
  // Generate RSA keypair for signing/verification
  const { privateKey, publicKey } = await generateKeyPair("RS256");

  // Export public key as JWK
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key-1";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const jwks = JSON.stringify({ keys: [publicJwk] });

  // Create HTTP server to serve JWKS
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(jwks);
  });

  // Start server on random available port
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to get server address");
  }

  const jwksUrl = `http://127.0.0.1:${addr.port}/.well-known/jwks.json`;

  /**
   * Helper function to create signed JWT with test claims
   */
  async function createTestJwt(overrides: Record<string, unknown> = {}): Promise<string> {
    const claims = createTestJwtClaims(overrides);

    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .setIssuedAt(claims.iat)
      .setNotBefore(claims.iat)
      .setExpirationTime(claims.exp)
      .setIssuer("http://localhost:3000")
      .setAudience("api")
      .sign(privateKey);
  }

  /**
   * Stop the JWKS server
   */
  async function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  return {
    server,
    jwksUrl,
    privateKey,
    createTestJwt,
    close,
  };
}

/**
 * Create an expired JWT for testing token expiry
 */
export async function createExpiredJwt(privateKey: KeyLike): Promise<string> {
  const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
  const claims = createTestJwtClaims({
    iat: pastTime,
    exp: pastTime + 300, // Expired 55 minutes ago
  });

  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt(claims.iat)
    .setNotBefore(claims.iat)
    .setExpirationTime(claims.exp)
    .setIssuer("http://localhost:3000")
    .setAudience("api")
    .sign(privateKey);
}

/**
 * Create a tampered JWT (invalid signature) for testing signature validation
 */
export async function createTamperedJwt(privateKey: KeyLike): Promise<string> {
  const token = await new SignJWT(createTestJwtClaims())
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .setIssuer("http://localhost:3000")
    .setAudience("api")
    .sign(privateKey);

  // Tamper with the signature
  const parts = token.split(".");
  const tamperedSignature = parts[2]!.slice(0, -5) + "XXXXX";
  return `${parts[0]!}.${parts[1]!}.${tamperedSignature}`;
}
