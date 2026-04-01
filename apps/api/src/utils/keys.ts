/**
 * JWT key pair management for signing user-auth JWTs and serving JWKS.
 *
 * Moved from apps/web/src/lib/keys.ts — now runs in Fastify alongside
 * Better Auth (consolidates all auth server-side logic).
 *
 * Production: imports private key from JWT_PRIVATE_KEY env (PEM format).
 * Development: generates an ephemeral RS256 key pair on first call.
 */
import { generateKeyPair, exportJWK, importPKCS8, type KeyLike, type JWK } from "jose";
import { randomUUID } from "node:crypto";

const JWT_SIGNING_ALG = process.env["JWT_SIGNING_ALG"] ?? "RS256";

interface KeyPairState {
  privateKey: KeyLike;
  publicJwk: JWK;
  kid: string;
}

let cached: KeyPairState | null = null;
let loadPromise: Promise<KeyPairState> | null = null;

/**
 * Get or generate the signing key pair.
 * If JWT_PRIVATE_KEY env var is set (PEM), import it.
 * Otherwise, generate a new key pair on first call (dev mode).
 *
 * In-flight deduplication prevents concurrent first-callers from each
 * generating a different ephemeral key pair (sign/JWKS mismatch).
 */
async function loadKeyPair(): Promise<KeyPairState> {
  if (cached) return cached;
  if (loadPromise) return loadPromise;

  loadPromise = _doLoadKeyPair().finally(() => { loadPromise = null; });
  return loadPromise;
}

async function _doLoadKeyPair(): Promise<KeyPairState> {
  if (cached) return cached;

  const kid = process.env["JWT_KID"] ?? randomUUID();

  const pemEnv = process.env["JWT_PRIVATE_KEY"];
  if (pemEnv) {
    // Node --env-file keeps literal \n — convert to real newlines for PEM parsing
    const pem = pemEnv.replace(/\\n/g, "\n");
    const privateKey = await importPKCS8(pem, JWT_SIGNING_ALG);
    const fullJwk = await exportJWK(privateKey);

    // Strip private components — JWKS endpoint only serves public key
    const pubJwk = stripPrivateComponents(fullJwk);
    pubJwk.kid = kid;
    pubJwk.alg = JWT_SIGNING_ALG;
    pubJwk.use = "sig";

    cached = { privateKey, publicJwk: pubJwk, kid };
    return cached;
  }

  // Dev mode: generate ephemeral key pair
  const { privateKey, publicKey } = await generateKeyPair(JWT_SIGNING_ALG);

  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = kid;
  publicJwk.alg = JWT_SIGNING_ALG;
  publicJwk.use = "sig";

  cached = { privateKey, publicJwk, kid };
  return cached;
}

/** Strip private key components from a JWK, keeping only public components. */
function stripPrivateComponents(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, ...publicComponents } = jwk;
  return publicComponents;
}

/** Get the private key for signing JWTs. */
export async function getPrivateKey(): Promise<KeyLike> {
  const { privateKey } = await loadKeyPair();
  return privateKey;
}

/** Get the key ID for the current signing key. */
export async function getKid(): Promise<string> {
  const { kid } = await loadKeyPair();
  return kid;
}

/** Get the JWKS (JSON Web Key Set) containing the public key. */
export async function getJwks(): Promise<{ keys: JWK[] }> {
  const { publicJwk } = await loadKeyPair();
  return { keys: [publicJwk] };
}
