import { SignJWT, jwtVerify, createRemoteJWKSet, importPKCS8, type JWTPayload, type JWTVerifyOptions, type KeyLike } from "jose";

/**
 * JWT claims for AgentHiFive internal API access.
 * sub = userId, wid = workspaceId, sid = sessionId
 */
export interface JwtClaims extends JWTPayload {
  sub: string;
  wid: string;
  roles: string[];
  scp: string[];
  sid: string;
  platformRole?: string;
}

/** Default JWT time-to-live: 5 minutes */
const DEFAULT_TTL_SECONDS = 300;

/** Configurable signing algorithm (ready for post-quantum migration) */
const JWT_SIGNING_ALG = process.env["JWT_SIGNING_ALG"] ?? "RS256";

export interface SignJwtOptions {
  /** JWT TTL in seconds (default: 300 = 5 minutes) */
  ttl?: number;
  /** Key ID for JWKS rotation */
  kid?: string;
  /** Issuer claim (required — identifies the token issuer) */
  issuer: string;
  /** Audience claim (required — identifies the intended recipient) */
  audience: string;
}

/**
 * Sign a JWT with the given claims and private key.
 * Uses RS256 by default (configurable via JWT_SIGNING_ALG env var).
 */
export async function signJwt(
  claims: JwtClaims,
  privateKey: KeyLike | Uint8Array,
  options: SignJwtOptions,
): Promise<string> {
  const {
    ttl = DEFAULT_TTL_SECONDS,
    kid,
    issuer,
    audience,
  } = options;

  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: JWT_SIGNING_ALG, ...(kid ? { kid } : {}) })
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime(`${ttl}s`)
    .setIssuer(issuer)
    .setAudience(audience);

  return builder.sign(privateKey);
}

/**
 * Verify a JWT against a remote JWKS endpoint.
 * Returns the validated payload.
 */
export async function verifyJwt(
  token: string,
  jwksUrl: string | URL,
  options: { issuer?: string; audience?: string } = {},
): Promise<JwtClaims> {
  const jwks = createRemoteJWKSet(new URL(jwksUrl.toString()));

  const verifyOptions: JWTVerifyOptions = {
    algorithms: [JWT_SIGNING_ALG],
  };
  if (options.issuer) {
    verifyOptions.issuer = options.issuer;
  }
  if (options.audience) {
    verifyOptions.audience = options.audience;
  }

  const { payload } = await jwtVerify(token, jwks, verifyOptions);

  return payload as JwtClaims;
}

/**
 * Import a PEM-encoded PKCS8 private key for signing.
 * Convenience wrapper around jose's importPKCS8.
 */
export async function importPrivateKey(pem: string): Promise<KeyLike> {
  return importPKCS8(pem, JWT_SIGNING_ALG);
}
