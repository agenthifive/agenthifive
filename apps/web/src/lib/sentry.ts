import * as Sentry from "@sentry/react";

// DSN is public (only allows sending events, not reading) — safe in client bundle.
// Replace with your Sentry "web" project DSN.
const SENTRY_DSN = "https://2ffd355875a2301e3abae1802e289e52@o4511101568090112.ingest.de.sentry.io/4511102244159568";

function getSentryEnvironment(): string {
  if (typeof window === "undefined") return "development";
  const host = window.location.hostname;
  if (host === "app.agenthifive.com") return "production";
  if (host === "app-integration.agenthifive.com") return "integration";
  return "development";
}

/** Keys whose values must never leave the browser. */
const SCRUB_KEYS =
  /^(authorization|cookie|password|secret|token|apikey|api_key|access_token|refresh_token|client_secret|dsn|private_key)$/i;

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
    environment: getSentryEnvironment(),

    // Performance monitoring
    tracesSampleRate: getSentryEnvironment() === "production" ? 0.2 : 1.0,
    // Session replay off by default — enable with replaysSessionSampleRate
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,

    // Do NOT send PII
    sendDefaultPii: false,

    beforeSend(event) {
      // Scrub request headers
      if (event.request?.headers) {
        const headers = { ...event.request.headers };
        for (const name of Object.keys(headers)) {
          if (/^(authorization|cookie|x-api-key)$/i.test(name)) {
            headers[name] = "[REDACTED]";
          }
        }
        event.request.headers = headers;
      }

      // Scrub cookies
      if (event.request?.cookies) {
        event.request.cookies = {};
      }

      // Scrub extra context
      if (event.extra) {
        event.extra = scrubObject(event.extra as Record<string, unknown>);
      }

      // Scrub breadcrumb data
      if (event.breadcrumbs) {
        for (const bc of event.breadcrumbs) {
          if (bc.data && typeof bc.data === "object") {
            bc.data = scrubObject(bc.data as Record<string, unknown>);
          }
        }
      }

      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      // Strip tokens from HTTP breadcrumb URLs
      if (breadcrumb.category === "fetch" && breadcrumb.data?.url) {
        const url = String(breadcrumb.data.url);
        if (url.includes("token") || url.includes("key") || url.includes("secret")) {
          try {
            const u = new URL(url, window.location.origin);
            for (const key of [...u.searchParams.keys()]) {
              if (/token|key|secret|code/i.test(key)) {
                u.searchParams.set(key, "[REDACTED]");
              }
            }
            breadcrumb.data = { ...breadcrumb.data, url: u.toString() };
          } catch {
            // Malformed — leave as-is
          }
        }
      }
      return breadcrumb;
    },

    ignoreErrors: [
      // Browser navigation aborts
      "AbortError",
      "TypeError: Failed to fetch",
      "TypeError: NetworkError",
      "TypeError: Load failed",
      // ResizeObserver noise
      "ResizeObserver loop",
    ],
  });
}

export { Sentry };
