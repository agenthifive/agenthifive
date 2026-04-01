/**
 * User authentication routes — Better Auth handler, JWKS, OAuth callback proxy.
 *
 * These routes run outside the /v1 prefix and handle their own auth
 * via Better Auth session cookies (not JWTs).
 */
import type { FastifyInstance } from "fastify";
import { nodeHandler } from "../plugins/better-auth";
import { getJwks } from "../utils/keys";
import { verifyTurnstileToken } from "../utils/turnstile";

export default async function userAuthRoutes(fastify: FastifyInstance) {
  // ── Better Auth catch-all ──────────────────────────────────────────
  // Scoped plugin: override body parsing so Better Auth can read the raw
  // request body stream (Fastify would otherwise consume it).
  await fastify.register(async function betterAuthScope(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "*",
      (_request: unknown, _payload: unknown, done: (err: null) => void) => done(null),
    );

    scope.all(
      "/api/auth/*",
      {
        config: { skipAuth: true },
        schema: {
          hide: true, // Exclude from OpenAPI spec — Better Auth manages its own routes
        },
      },
      async (request, reply) => {
        // Better Auth's internal router returns 404 for trailing slashes.
        // Strip them before forwarding (e.g. /get-session/ → /get-session).
        const url = request.raw.url;
        if (url && url !== "/api/auth/" && url.endsWith("/")) {
          request.raw.url = url.replace(/\/+(\?|$)/, "$1");
        }

        // Turnstile bot check on email sign-up (not social — providers handle that).
        // Token sent via X-Turnstile-Token header to avoid body-parsing conflicts.
        if (url?.startsWith("/api/auth/sign-up/email")) {
          const turnstileToken = request.headers["x-turnstile-token"] as string | undefined;
          const ok = await verifyTurnstileToken(turnstileToken, request.ip);
          if (!ok) {
            reply.code(403).send({ code: "TURNSTILE_FAILED", message: "Bot check failed. Please try again." });
            return;
          }
        }

        // Log auth operations that would otherwise be silent (Better Auth handles
        // the response directly via reply.hijack, so Fastify never sees the outcome).
        const isVerifyEmail = url?.startsWith("/api/auth/verify-email");
        const isSignIn = url?.startsWith("/api/auth/sign-in");
        const isSignUp = url?.startsWith("/api/auth/sign-up");

        if (isVerifyEmail || isSignIn || isSignUp) {
          const origWriteHead = reply.raw.writeHead.bind(reply.raw) as (...a: unknown[]) => void;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (reply.raw as any).writeHead = function (statusCode: number, ...rest: unknown[]) {
            const location = reply.raw.getHeader("location") as string | undefined;
            if (isVerifyEmail) {
              if (location?.includes("error=")) {
                request.log.warn({ statusCode, location }, "Email verification failed");
              } else {
                request.log.info({ statusCode, location }, "Email verification succeeded");
              }
            } else if (isSignIn && statusCode >= 400) {
              request.log.info({ statusCode, email: "(redacted)" }, "Sign-in failed");
            } else if (isSignUp) {
              request.log.info({ statusCode }, "Sign-up attempt");
            }
            return origWriteHead(statusCode, ...rest);
          };
        }

        // Tell Fastify we're handling the response ourselves
        reply.hijack();
        await nodeHandler(request.raw, reply.raw);
      },
    );
  });

  // ── JWKS endpoint ──────────────────────────────────────────────────
  // Public key for JWT verification. Cached by jose's createRemoteJWKSet.
  fastify.get(
    "/.well-known/jwks.json",
    {
      config: { skipAuth: true },
      schema: {
        tags: ["Health"],
        summary: "JSON Web Key Set",
        description: "Public key set for verifying JWTs issued by the token exchange endpoint.",
        security: [],
        response: {
          200: {
            type: "object",
            properties: {
              keys: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const jwks = await getJwks();
      reply.header("Cache-Control", "public, max-age=3600").send(jwks);
    },
  );

  // ── OAuth callback proxy ───────────────────────────────────────────
  // OAuth providers redirect here (registered as redirect_uri in provider
  // app configs). We forward the code+state to the API's /v1/connections/callback
  // which handles CSRF validation and token exchange.
  fastify.get(
    "/api/connections/callback",
    {
      config: { skipAuth: true },
      schema: {
        hide: true, // Internal redirect, not a user-facing API
      },
    },
    async (request, reply) => {
      const params = new URLSearchParams(
        request.query as Record<string, string>,
      );
      reply.redirect(`/v1/connections/callback?${params.toString()}`);
    },
  );
}
