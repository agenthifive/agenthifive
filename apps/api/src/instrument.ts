/**
 * Sentry instrumentation — must be loaded before all other imports.
 *
 * In dev:  tsx --import ./src/instrument.ts ...
 * In prod: node --import ./dist/instrument.js ...
 *
 * Security: beforeSend scrubs auth headers, tokens, cookies, and PII-adjacent
 * fields so that sensitive data never leaves the infrastructure.
 */
import * as Sentry from "@sentry/node";

const SENTRY_DSN = process.env["SENTRY_DSN"];

/** Header names that must never reach Sentry (lowercase). */
const SCRUB_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "x-ah5-bypass-pii-redaction",
  "x-ah5-session-key",
  "x-forwarded-for",
  "x-real-ip",
]);

/** Keys anywhere in the event JSON whose values should be redacted. */
const SCRUB_KEYS =
  /^(authorization|cookie|x-api-key|password|secret|token|apikey|api_key|access_token|refresh_token|bot_token|encrypted|private_key|client_secret|dsn|sentry_dsn|bootstrap_secret)$/i;

/** Strip sensitive fields from an arbitrary object (shallow clone). */
function scrubObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = SCRUB_KEYS.test(k) ? "[REDACTED]" : v;
  }
  return out;
}

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env["SENTRY_ENVIRONMENT"] || "development",
    release: process.env["GIT_SHA"] || "dev",
    ...(process.env["SENTRY_SERVER_NAME"] && { serverName: process.env["SENTRY_SERVER_NAME"] }),

    // Performance monitoring
    tracesSampleRate: process.env["SENTRY_TRACES_SAMPLE_RATE"]
      ? Number(process.env["SENTRY_TRACES_SAMPLE_RATE"])
      : 0.2,

    // Do NOT attach cookies, user IPs, or auth headers by default
    sendDefaultPii: false,

    integrations: [
      Sentry.fastifyIntegration(),
    ],

    // Security: scrub sensitive data before it leaves the server
    beforeSend(event) {
      // Scrub request headers
      if (event.request?.headers) {
        const headers = { ...event.request.headers };
        for (const name of Object.keys(headers)) {
          if (SCRUB_HEADERS.has(name.toLowerCase())) {
            headers[name] = "[REDACTED]";
          }
        }
        event.request.headers = headers;
      }

      // Scrub request cookies (should be empty with sendDefaultPii:false, but belt-and-suspenders)
      if (event.request?.cookies) {
        event.request.cookies = {};
      }

      // Never send request/response bodies
      if (event.request?.data) {
        event.request.data = "[REDACTED]";
      }

      // Scrub sensitive keys in extra context
      if (event.extra) {
        event.extra = scrubObject(event.extra as Record<string, unknown>);
      }

      // Scrub breadcrumb data (e.g. HTTP breadcrumbs may contain URLs with tokens)
      if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
          if (bc.data && typeof bc.data === "object") {
            bc.data = scrubObject(bc.data as Record<string, unknown>);
          }
        }
      }

      return event;
    },

    // Scrub sensitive data from breadcrumbs as they are added
    beforeBreadcrumb(breadcrumb) {
      // Strip auth headers from HTTP breadcrumbs
      if (breadcrumb.category === "http" && breadcrumb.data) {
        const data = { ...breadcrumb.data };
        // Remove any URL query params that might contain tokens
        if (typeof data.url === "string" && data.url.includes("token")) {
          try {
            const u = new URL(data.url);
            for (const key of [...u.searchParams.keys()]) {
              if (/token|key|secret|code/i.test(key)) {
                u.searchParams.set(key, "[REDACTED]");
              }
            }
            data.url = u.toString();
          } catch {
            // Relative URL or malformed — leave as-is
          }
        }
        breadcrumb.data = data;
      }
      return breadcrumb;
    },

    // Ignore routine errors that are not actionable
    ignoreErrors: [
      // Client disconnects mid-request (normal for long-poll, SSE)
      "ECONNRESET",
      "EPIPE",
      "ERR_STREAM_PREMATURE_CLOSE",
      // Rate-limit responses (expected, not bugs)
      "Too Many Requests",
    ],
  });
}

// ── Process-level safety net ────────────────────────────────────────
// Catch unhandled rejections and exceptions so they reach Sentry and
// appear in stderr instead of silently disappearing.

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  if (SENTRY_DSN) {
    Sentry.captureException(
      reason instanceof Error ? reason : new Error(String(reason)),
      { tags: { source: "unhandledRejection" } },
    );
  }
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  if (SENTRY_DSN) {
    Sentry.captureException(err, { tags: { source: "uncaughtException" } });
    // Flush before crashing — give Sentry up to 2s to send
    Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

export { Sentry };
