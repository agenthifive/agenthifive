import type { FastifyReply, FastifyRequest } from "fastify";
import { Sentry } from "../instrument";

/**
 * Send a 500 response, log the error, and report to Sentry.
 *
 * Use instead of bare `reply.code(500).send(...)` so that every server error
 * is captured by Sentry — not just unhandled throws that reach the global
 * error handler.
 */
export function reply500(
  reply: FastifyReply,
  error: unknown,
  userMessage: string,
  context?: { request?: FastifyRequest; extra?: Record<string, unknown> },
): ReturnType<FastifyReply["send"]> {
  const err = error instanceof Error ? error : new Error(String(error));

  if (context?.request) {
    context.request.log.error(err, userMessage);
  }

  Sentry.captureException(err, {
    tags: { source: "reply500" },
    ...(context?.extra && { extra: context.extra }),
  });

  return reply.code(500).send({ error: userMessage });
}
