import type { FastifyRequest, FastifyReply } from "fastify";

/**
 * Fastify preHandler that checks if request.user.scp includes ALL specified scopes.
 * PATs with scp: ["*"] pass automatically.
 */
export function requireScope(...requiredScopes: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const userScopes = request.user.scp;
    if (userScopes.includes("*")) return;
    for (const scope of requiredScopes) {
      if (!userScopes.includes(scope)) {
        return reply.code(403).send({ error: `Missing required scope: ${scope}` });
      }
    }
  };
}
