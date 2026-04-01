/**
 * E2E Agent Authentication Helper
 *
 * Bootstraps an agent via the real AH5 API endpoints (unauthenticated)
 * and exchanges client assertions for access tokens.
 */
import { generateKeyPair, exportJWK, importJWK, SignJWT, type JWK, type KeyLike } from "jose";
import { randomUUID } from "node:crypto";

const AH5_API_URL = process.env["AH5_API_URL"] || "http://api:4000";
const TOKEN_AUDIENCE = process.env["AGENT_TOKEN_AUDIENCE"] || AH5_API_URL;

export interface BootstrapResult {
  agentId: string;
  name: string;
  status: string;
  workspaceId: string;
}

export interface TokenResult {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface AgentCredentials {
  agentId: string;
  workspaceId: string;
  accessToken: string;
  privateKey: JWK;
  publicKey: JWK;
  privateKeyObj: KeyLike;
}

/**
 * Generate an ES256 key pair for agent bootstrap.
 */
export async function generateAgentKeyPair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  return {
    privateKeyJWK: (await exportJWK(privateKey)) as JWK,
    publicKeyJWK: (await exportJWK(publicKey)) as JWK,
    privateKeyObj: privateKey,
    publicKeyObj: publicKey,
  };
}

/**
 * Bootstrap an agent with the AH5 API.
 * POST /v1/agents/bootstrap (unauthenticated)
 */
export async function bootstrapAgent(
  bootstrapSecret: string,
  publicKey: JWK,
): Promise<BootstrapResult> {
  const response = await fetch(`${AH5_API_URL}/v1/agents/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bootstrapSecret, publicKey }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Bootstrap failed: ${response.status} ${text}`);
  }

  return (await response.json()) as BootstrapResult;
}

/**
 * Sign a client assertion JWT for the agent token endpoint.
 */
export async function signClientAssertion(
  privateKey: KeyLike,
  agentId: string,
  overrides?: { audience?: string; expiresInSeconds?: number },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(agentId)
    .setSubject(agentId)
    .setAudience(overrides?.audience ?? TOKEN_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides?.expiresInSeconds ?? 30))
    .setJti(randomUUID())
    .sign(privateKey);
}

/**
 * Exchange a client assertion for an access token.
 * POST /v1/agents/token (unauthenticated)
 */
export async function exchangeToken(clientAssertion: string): Promise<TokenResult> {
  const response = await fetch(`${AH5_API_URL}/v1/agents/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_assertion",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: clientAssertion,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  return (await response.json()) as TokenResult;
}

/**
 * Full bootstrap + token exchange flow.
 * Returns everything needed to make authenticated API calls.
 */
export async function bootstrapAndAuthenticate(
  bootstrapSecret: string,
): Promise<AgentCredentials> {
  // 1. Generate key pair
  const { privateKeyJWK, publicKeyJWK, privateKeyObj } = await generateAgentKeyPair();

  // 2. Bootstrap
  const bootstrapped = await bootstrapAgent(bootstrapSecret, publicKeyJWK);

  // 3. Get access token
  const assertion = await signClientAssertion(privateKeyObj, bootstrapped.agentId);
  const tokenResult = await exchangeToken(assertion);

  return {
    agentId: bootstrapped.agentId,
    workspaceId: bootstrapped.workspaceId,
    accessToken: tokenResult.access_token,
    privateKey: privateKeyJWK,
    publicKey: publicKeyJWK,
    privateKeyObj,
  };
}

/**
 * Make an authenticated request to the AH5 API.
 */
export async function apiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return fetch(`${AH5_API_URL}${path}`, init);
}
