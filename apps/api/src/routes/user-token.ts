/**
 * POST /api/auth/token
 *
 * Exchange a valid Better Auth session cookie for a short-lived JWT.
 * The JWT is used by the frontend to authenticate API requests.
 *
 * Moved from apps/web/src/app/api/auth/token/route.ts — now runs in
 * Fastify alongside Better Auth.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { signJwt, type JwtClaims } from "@agenthifive/security";
import { auth, fromNodeHeaders } from "../plugins/better-auth";
import { getPrivateKey, getKid } from "../utils/keys";
import { sql } from "../db/client";

const JWT_TTL_SECONDS = 300; // 5 minutes
const ISSUER = process.env["WEB_URL"] ?? "http://localhost:3000";

export default async function userTokenRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/api/auth/token",
    {
      config: {
        skipAuth: true, // This route validates Better Auth session cookies, not JWTs
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        tags: ["Agent Auth"],
        summary: "Exchange session cookie for JWT",
        description:
          "Validates the Better Auth session cookie and returns a short-lived JWT " +
          "for authenticating API requests. The JWT contains user ID, workspace ID, " +
          "roles, and scopes. TTL is 5 minutes.",
        security: [],
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
            },
            required: ["token", "expiresAt"],
          },
          401: {
            type: "object",
            properties: { error: { type: "string" } },
          },
          403: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      // ── CSRF protection: reject cross-origin requests ──────────────
      const origin = request.headers.origin;
      if (origin && origin !== ISSUER) {
        request.log.debug({ origin, reason: "csrf" }, "token.denied");
        return reply.code(403).send({ error: "Forbidden" });
      }
      const secFetchSite = request.headers["sec-fetch-site"];
      if (secFetchSite === "cross-site") {
        request.log.debug({ origin, reason: "csrf" }, "token.denied");
        return reply.code(403).send({ error: "Forbidden" });
      }

      // ── Session validation ─────────────────────────────────────────
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.raw.headers),
      });

      if (!session) {
        request.log.debug({ reason: "no-session" }, "token.denied");
        return reply.code(401).send({ error: "Unauthorized — invalid or expired session" });
      }

      const { user, session: sess } = session;
      request.log.debug({ userId: user.id }, "token.session");

      // ── Check platform status (disabled? role?) ──────────────────
      const [userRow] = await sql`
        SELECT platform_role, disabled_at FROM t_users WHERE id = ${user.id}
      `;
      if (userRow?.disabled_at) {
        request.log.warn({ userId: user.id }, "token.denied.disabled");
        return reply.code(403).send({ error: "Account disabled" });
      }

      // ── Workspace lookup (+ auto-creation for legacy users) ────────
      let rows = await sql`
        SELECT id FROM t_workspaces WHERE owner_id = ${user.id} LIMIT 1
      `;

      let workspaceId: string;

      if (rows.length === 0) {
        const name = `${user.name || user.email}'s Workspace`;
        try {
          const createResult = await sql`
            INSERT INTO t_workspaces (id, name, owner_id, created_at, updated_at)
            VALUES (gen_random_uuid(), ${name}, ${user.id}, now(), now())
            RETURNING id
          `;
          workspaceId = createResult[0]!.id as string;
          request.log.debug({ userId: user.id, workspaceId }, "token.workspace.created");
        } catch (err) {
          // Race condition: another request created the workspace. Retry the SELECT.
          rows = await sql`
            SELECT id FROM t_workspaces WHERE owner_id = ${user.id} LIMIT 1
          `;
          if (rows.length === 0) {
            throw err; // Still no workspace — re-throw the original error
          }
          workspaceId = rows[0]!.id as string;
        }
      } else {
        workspaceId = rows[0]!.id as string;
      }

      // ── Build and sign JWT ─────────────────────────────────────────
      const claims: JwtClaims = {
        sub: user.id,
        wid: workspaceId,
        roles: ["owner"],
        scp: ["*"],
        sid: sess.id,
        jti: randomUUID(),
        platformRole: (userRow?.platform_role as string) || "user",
      };

      const [privateKey, kid] = await Promise.all([getPrivateKey(), getKid()]);

      const token = await signJwt(claims, privateKey, {
        ttl: JWT_TTL_SECONDS,
        kid,
        issuer: ISSUER,
        audience: "api",
      });

      const expiresAt = new Date(Date.now() + JWT_TTL_SECONDS * 1000).toISOString();

      request.log.debug({ userId: user.id, workspaceId, ttl: JWT_TTL_SECONDS }, "token.issued");

      return reply.send({ token, expiresAt });
    },
  );
}
