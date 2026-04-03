import { signOut } from "@/lib/auth-client";

const API_URL = typeof window !== "undefined" ? window.location.origin + "/v1" : "/v1";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network-level fetch failures surface as TypeError in browsers */
function isTransientError(err: unknown): boolean {
  return err instanceof TypeError;
}

// ── Token caching ────────────────────────────────────────────────
// Cache tokens to avoid hitting rate limit (30/min) on token endpoint.
// JWTs are valid for 5 minutes, so we cache and reuse them.
let cachedToken: string | null = null;
let tokenExpiresAt: number = 0;
// In-flight deduplication: concurrent callers await the same promise instead
// of each firing a separate /v1/auth/token request on the initial page load.
let tokenFetchPromise: Promise<string> | null = null;

/**
 * Fetches a JWT from the token exchange endpoint (session cookie → JWT).
 * Caches tokens and reuses them until they expire to avoid rate limiting.
 * Must be called from client-side code where session cookie is available.
 *
 * On 401 (session expired / invalid): signs out and redirects to login.
 */
async function getToken(): Promise<string> {
  // Return cached token if still valid (with 30s buffer before expiry)
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 30_000) {
    return cachedToken;
  }

  // If a fetch is already in flight, wait for it rather than firing another
  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    const res = await fetch("/v1/auth/token", { method: "POST" });

    if (res.status === 401) {
      // Session is dead — clear cookies and redirect to login
      await signOut().catch(() => {});
      window.location.href = "/login";
      throw new Error("Session expired");
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      console.error(`Token endpoint failed: ${res.status} ${res.statusText}`, errorText);
      throw new Error(`Failed to get API token: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { token: string; expiresAt: string };
    cachedToken = data.token;
    tokenExpiresAt = new Date(data.expiresAt).getTime();
    return data.token;
  })().finally(() => {
    tokenFetchPromise = null;
  });

  return tokenFetchPromise;
}

/**
 * Authenticated fetch to the Fastify API.
 * Automatically exchanges session cookie for JWT.
 *
 * Retries up to 2 times on transient errors (network failures, 502/503)
 * to handle server startup race conditions after restart.
 */
export async function apiFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const token = await getToken();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (options.body) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(`${API_URL}${path}`, {
        ...options,
        headers: {
          ...headers,
          ...options.headers,
        },
      });

      // Retry on gateway errors (server not ready after restart)
      if ((res.status === 502 || res.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`Server returned ${res.status}`);
        await delay(RETRY_BASE_MS * (attempt + 1));
        continue;
      }

      return res;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && isTransientError(err)) {
        await delay(RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}
