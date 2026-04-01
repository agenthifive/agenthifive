/**
 * Shared JWT utilities for ES256 client assertion auth.
 *
 * Used by both VaultClient (on-demand token refresh) and
 * VaultTokenManager (background token refresh).
 */

import { SignJWT, importJWK, type KeyLike, type JWK } from "jose";

export type TokenExchangeConfig = {
  baseUrl: string;
  agentId: string;
  tokenAudience: string;
};

export type TokenExchangeResult = {
  accessToken: string;
  expiresIn: number;
};

/**
 * Import a JWK as a KeyLike object for ES256 signing.
 */
export async function importES256Key(jwk: JsonWebKey): Promise<KeyLike> {
  return (await importJWK(jwk as JWK, "ES256")) as KeyLike;
}

/**
 * Sign an ES256 client assertion JWT and exchange it for an access token.
 */
export async function exchangeToken(
  privateKey: KeyLike,
  config: TokenExchangeConfig,
): Promise<TokenExchangeResult> {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(config.agentId)
    .setSubject(config.agentId)
    .setAudience(config.tokenAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .setJti(crypto.randomUUID())
    .sign(privateKey);

  const response = await fetch(`${config.baseUrl}/v1/agents/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_assertion",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new TokenExchangeError(
      `Token exchange failed: ${response.status} ${text}`,
      response.status,
    );
  }

  const result = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  return {
    accessToken: result.access_token,
    expiresIn: result.expires_in,
  };
}

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "TokenExchangeError";
  }
}
