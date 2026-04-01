import fp from "fastify-plugin";
import { reply500 } from "../utils/reply-error";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyOptions } from "jose";
import { createHash } from "node:crypto";
import { eq, and, isNull, gt } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../db/client";
import { personalAccessTokens } from "../db/schema/personal-access-tokens";
import { agentAccessTokens } from "../db/schema/agent-access-tokens";

/** JWT claims decoded from the Authorization header */
export interface UserClaims {
  /** User ID (or "agent:<uuid>" for agent access tokens) */
  sub: string;
  /** Workspace ID */
  wid: string;
  /** Workspace roles */
  roles: string[];
  /** Scopes */
  scp: string[];
  /** Session ID */
  sid: string;
  /** Agent ID — populated when auth is via agent access token (ah5t_) */
  agentId?: string;
  /** Platform role — "user" | "superadmin". Absent means "user". */
  platformRole: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user: UserClaims;
  }
  interface RouteOptions {
    skipAuth?: boolean;
  }
  interface FastifyContextConfig {
    skipAuth?: boolean;
  }
}

const JWT_SIGNING_ALG = process.env["JWT_SIGNING_ALG"] ?? "RS256";
const JWT_ISSUER = process.env["WEB_URL"] || "http://localhost:3000";
const JWT_AUDIENCE = "api";

/**
 * Resolve user claims from a Personal Access Token (X-API-Key header).
 * Returns null if the token is invalid, expired, or revoked.
 */
async function resolvePatClaims(
  apiKey: string,
  request: FastifyRequest,
): Promise<UserClaims | null> {
  // Only accept PAT-prefixed keys
  if (!apiKey.startsWith("ah5p_")) return null;

  const hash = createHash("sha256").update(apiKey).digest("hex");

  const [row] = await db
    .select({
      id: personalAccessTokens.id,
      userId: personalAccessTokens.userId,
      workspaceId: personalAccessTokens.workspaceId,
    })
    .from(personalAccessTokens)
    .where(
      and(
        eq(personalAccessTokens.tokenHash, hash),
        isNull(personalAccessTokens.revokedAt),
        gt(personalAccessTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  if (!row) return null;

  // Fire-and-forget: update lastUsedAt (never block response)
  db.update(personalAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(personalAccessTokens.id, row.id))
    .then(() => {})
    .catch((err) => request.log.error({ err }, "Failed to update PAT lastUsedAt"));

  return {
    sub: row.userId,
    wid: row.workspaceId,
    roles: ["owner"],
    scp: ["*"],
    sid: `pat:${row.id}`,
    platformRole: "user", // PATs don't carry platform role; always "user"
  };
}

/**
 * Resolve user claims from an Agent Access Token.
 * Returns null if the token doesn't match the ah5t_ prefix or is invalid/expired.
 * Token is validated at request start only — long-running Model B calls
 * complete even if the token expires mid-request.
 */
async function resolveAgentAccessToken(
  token: string,
  request: FastifyRequest,
): Promise<UserClaims | null> {
  if (!token.startsWith("ah5t_")) return null;

  const hash = createHash("sha256").update(token).digest("hex");

  const [row] = await db
    .select({
      id: agentAccessTokens.id,
      agentId: agentAccessTokens.agentId,
      workspaceId: agentAccessTokens.workspaceId,
      expiresAt: agentAccessTokens.expiresAt,
    })
    .from(agentAccessTokens)
    .where(eq(agentAccessTokens.tokenHash, hash))
    .limit(1);

  if (!row) {
    request.log.warn({ tokenPrefix: token.slice(0, 12), hashPrefix: hash.slice(0, 12) }, "agent-token: hash not found in DB (token may have been deleted by re-bootstrap or never existed)");
    return null;
  }

  // Check expiry
  if (row.expiresAt <= new Date()) {
    request.log.warn(
      { tokenPrefix: token.slice(0, 12), agentId: row.agentId, expiredAt: row.expiresAt.toISOString(), now: new Date().toISOString() },
      "agent-token: expired",
    );
    return null;
  }

  // Fire-and-forget: update lastUsedAt
  db.update(agentAccessTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(agentAccessTokens.id, row.id))
    .then(() => {})
    .catch((err) => request.log.error({ err }, "Failed to update agent token lastUsedAt"));

  return {
    sub: `agent:${row.agentId}`,
    wid: row.workspaceId,
    roles: ["agent"],
    scp: ["vault:execute", "capabilities:read", "capabilities:request"],
    sid: `agent-token:${row.id}`,
    agentId: row.agentId,
    platformRole: "user",
  };
}

export default fp(
  async function jwtAuthPlugin(fastify: FastifyInstance) {
    const jwksUrl = process.env["WEB_JWKS_URL"];
    if (!jwksUrl) {
      fastify.log.warn("WEB_JWKS_URL not set — JWT verification will fail at runtime");
    }

    const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : null;

    // Decorate request with empty user claims (Fastify requires a default)
    fastify.decorateRequest("user", null as unknown as UserClaims);

    // onRequest hook that checks JWT or PAT unless route opts out
    fastify.addHook(
      "onRequest",
      async function verifyAuth(request: FastifyRequest, reply: FastifyReply) {
        // Skip auth if route is explicitly marked
        if (request.routeOptions.config.skipAuth) {
          return;
        }

        // Skip auth for Swagger UI and OpenAPI spec routes
        if (request.url.startsWith("/docs")) {
          return;
        }

        const authHeader = request.headers.authorization;
        const apiKey = (request.headers["x-api-key"] as string | undefined)
          ?? (request.headers["x-goog-api-key"] as string | undefined);

        const authType = authHeader
          ? authHeader.startsWith("Bearer ah5t_") ? "agent-token"
            : authHeader.startsWith("Bearer ah5p_") ? "pat-bearer"
            : "jwt"
          : apiKey ? "api-key" : "none";
        request.log.debug({ authType }, "auth.start");

        // Path 1: Bearer token (JWT or API key)
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);

          // Agent access tokens and PATs sent via Bearer header (e.g., from LLM SDK clients
          // like OpenAI SDK that use Authorization: Bearer <key>).
          if (token.startsWith("ah5t_") || token.startsWith("ah5p_")) {
            const claims = await resolvePatClaims(token, request)
                        ?? await resolveAgentAccessToken(token, request);
            if (!claims) {
              reply.code(401).send({ error: "Invalid or expired API key" });
              return;
            }
            request.log.debug({ authMethod: claims.agentId ? "agent-token" : "pat", sub: claims.sub, wid: claims.wid }, "auth.resolved");
            request.user = claims;
            return;
          }

          if (!jwks) {
            reply500(reply, new Error("JWT verification not configured (WEB_JWKS_URL missing)"), "JWT verification not configured (WEB_JWKS_URL missing)", { request });
            return;
          }

          try {
            const verifyOptions: JWTVerifyOptions = {
              algorithms: [JWT_SIGNING_ALG],
              issuer: JWT_ISSUER,
              audience: JWT_AUDIENCE,
            };

            const { payload } = await jwtVerify(token, jwks, verifyOptions);

            // Validate required claims
            const sub = payload.sub;
            const wid = payload["wid"];
            const roles = payload["roles"];
            const scp = payload["scp"];
            const sid = payload["sid"];

            if (
              typeof sub !== "string" ||
              typeof wid !== "string" ||
              !Array.isArray(roles) ||
              !Array.isArray(scp) ||
              typeof sid !== "string"
            ) {
              reply.code(401).send({ error: "Invalid JWT claims" });
              return;
            }

            const platformRole = (payload["platformRole"] as string) || "user";

            request.user = {
              sub,
              wid,
              roles: roles as string[],
              scp: scp as string[],
              sid,
              platformRole,
            };
            request.log.debug({ authMethod: "jwt", sub, wid, roles }, "auth.resolved");
          } catch (err) {
            request.log.warn({ err: String(err) }, "JWT verification failed");
            reply.code(401).send({ error: "Invalid or expired token" });
          }
          return;
        }

        // Path 2: API key headers (PAT or agent access token)
        // Gemini SDKs send x-goog-api-key instead of x-api-key, so accept both.
        if (apiKey) {
          const claims = await resolvePatClaims(apiKey, request)
                      ?? await resolveAgentAccessToken(apiKey, request);
          if (!claims) {
            reply.code(401).send({ error: "Invalid or expired API key" });
            return;
          }
          request.log.debug({ authMethod: claims.agentId ? "agent-token" : "pat", sub: claims.sub, wid: claims.wid }, "auth.resolved");
          request.user = claims;
          return;
        }

        // No credentials provided
        reply.code(401).send({ error: "Missing Authorization header, X-API-Key, or X-Goog-Api-Key" });
      },
    );
  },
  {
    name: "jwt-auth",
    fastify: "5.x",
  },
);
