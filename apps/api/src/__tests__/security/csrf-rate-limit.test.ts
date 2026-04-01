import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Tests for CSRF protection and rate limiting on the token endpoint.
 *
 * The token endpoint (apps/web/src/app/api/auth/token/route.ts) uses:
 * 1. Origin header check — rejects if Origin doesn't match expected URL
 * 2. Sec-Fetch-Site check — rejects if value is "cross-site"
 * 3. In-memory IP-based rate limiting — 30 req/min per IP
 *
 * Since the actual endpoint is a Next.js Route Handler with hard-to-mock
 * dependencies (Better Auth, DB, JWKS), we replicate the exact security
 * checks here to verify the logic is correct. The CSRF and rate limit
 * code is extracted verbatim from route.ts.
 */

// ── Replicated CSRF + rate limit logic from route.ts ────────────────

const EXPECTED_ORIGIN = "http://localhost:3000";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  // CSRF: Origin header check
  const origin = req.headers["origin"] as string | undefined;
  if (origin && origin !== EXPECTED_ORIGIN) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  // CSRF: Sec-Fetch-Site header check
  const secFetchSite = req.headers["sec-fetch-site"] as string | undefined;
  if (secFetchSite === "cross-site") {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return;
  }

  // Rate limiting
  const xff = req.headers["x-forwarded-for"] as string | undefined;
  const ip = xff?.split(",")[0]?.trim()
    || (req.headers["x-real-ip"] as string | undefined)
    || "unknown";
  if (!checkRateLimit(ip)) {
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "60",
    });
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }

  // If all security checks pass, return 401 (no session in test)
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

// ── Helper to make requests to test server ──────────────────────────

async function request(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, string>; headers: Record<string, string> }> {
  const res = await fetch(url, {
    method: "POST",
    headers,
  });
  const body = (await res.json()) as Record<string, string>;
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    resHeaders[key] = value;
  });
  return { status: res.status, body, headers: resHeaders };
}

// ── Tests ───────────────────────────────────────────────────────────

describe("Token Endpoint Security (CSRF + Rate Limiting)", () => {
  let server: Server;
  let baseUrl: string;

  before(async () => {
    server = createServer(handleRequest);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Server bind failed");
    baseUrl = `http://127.0.0.1:${addr.port}/api/auth/token`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  // ── CSRF Protection ─────────────────────────────────────────────

  describe("CSRF Protection — Origin header", () => {
    it("rejects request with cross-origin Origin header", async () => {
      const res = await request(baseUrl, {
        origin: "https://evil.example.com",
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error, "Forbidden");
    });

    it("rejects request with localhost on different port", async () => {
      const res = await request(baseUrl, {
        origin: "http://localhost:9999",
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error, "Forbidden");
    });

    it("rejects request with HTTP vs HTTPS mismatch", async () => {
      const res = await request(baseUrl, {
        origin: "https://localhost:3000",
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error, "Forbidden");
    });

    it("allows request with matching Origin header", async () => {
      const res = await request(baseUrl, {
        origin: EXPECTED_ORIGIN,
      });

      // Should pass CSRF and hit auth (returns 401 since no session)
      assert.equal(res.status, 401);
    });

    it("allows request with no Origin header (same-origin navigations)", async () => {
      const res = await request(baseUrl, {});

      // No Origin header → CSRF check passes → hits auth → 401
      assert.equal(res.status, 401);
    });
  });

  describe("CSRF Protection — Sec-Fetch-Site header", () => {
    it("rejects request with Sec-Fetch-Site: cross-site", async () => {
      const res = await request(baseUrl, {
        "sec-fetch-site": "cross-site",
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.error, "Forbidden");
    });

    it("allows request with Sec-Fetch-Site: same-origin", async () => {
      const res = await request(baseUrl, {
        "sec-fetch-site": "same-origin",
      });

      assert.equal(res.status, 401); // Passes CSRF, fails auth
    });

    it("allows request with Sec-Fetch-Site: same-site", async () => {
      const res = await request(baseUrl, {
        "sec-fetch-site": "same-site",
      });

      assert.equal(res.status, 401); // Passes CSRF
    });

    it("allows request with Sec-Fetch-Site: none (direct navigation)", async () => {
      const res = await request(baseUrl, {
        "sec-fetch-site": "none",
      });

      assert.equal(res.status, 401); // Passes CSRF
    });
  });

  describe("CSRF Protection — Combined checks", () => {
    it("rejects when both Origin and Sec-Fetch-Site indicate cross-origin", async () => {
      const res = await request(baseUrl, {
        origin: "https://evil.example.com",
        "sec-fetch-site": "cross-site",
      });

      assert.equal(res.status, 403);
    });

    it("rejects when Origin is wrong even if Sec-Fetch-Site is same-origin", async () => {
      // Origin check fires first
      const res = await request(baseUrl, {
        origin: "https://evil.example.com",
        "sec-fetch-site": "same-origin",
      });

      assert.equal(res.status, 403);
    });

    it("rejects when Sec-Fetch-Site is cross-site even with no Origin", async () => {
      const res = await request(baseUrl, {
        "sec-fetch-site": "cross-site",
      });

      assert.equal(res.status, 403);
    });
  });

  // ── Rate Limiting ─────────────────────────────────────────────────

  describe("Rate Limiting", () => {
    it("returns 429 after exceeding 30 requests per minute from same IP", async () => {
      // Reset the rate limit map for a clean test
      rateLimitMap.clear();

      const testIp = "192.168.100.42";

      // Send 30 requests (all should pass rate limit check)
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        const res = await request(baseUrl, {
          "x-forwarded-for": testIp,
        });
        assert.notEqual(
          res.status,
          429,
          `Request ${i + 1} should not be rate limited`,
        );
      }

      // Request 31 should be rate limited
      const res = await request(baseUrl, {
        "x-forwarded-for": testIp,
      });
      assert.equal(res.status, 429);
      assert.equal(res.body.error, "Too many requests");
      assert.equal(res.headers["retry-after"], "60");
    });

    it("tracks rate limits per IP — different IPs have separate budgets", async () => {
      rateLimitMap.clear();

      // Exhaust limit for IP-A
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        await request(baseUrl, { "x-forwarded-for": "10.0.0.1" });
      }

      // IP-A should be limited
      const resA = await request(baseUrl, {
        "x-forwarded-for": "10.0.0.1",
      });
      assert.equal(resA.status, 429, "IP-A should be rate limited");

      // IP-B should still have budget
      const resB = await request(baseUrl, {
        "x-forwarded-for": "10.0.0.2",
      });
      assert.notEqual(resB.status, 429, "IP-B should not be rate limited");
    });

    it("uses X-Real-IP as fallback when X-Forwarded-For is absent", async () => {
      rateLimitMap.clear();

      const testIp = "172.16.0.99";

      // Exhaust limit using X-Real-IP
      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        await request(baseUrl, { "x-real-ip": testIp });
      }

      const res = await request(baseUrl, { "x-real-ip": testIp });
      assert.equal(res.status, 429);
    });

    it("rate limit window resets after expiry", async () => {
      // Directly test the checkRateLimit function with a synthetic expired entry
      rateLimitMap.clear();
      rateLimitMap.set("expired-ip", {
        count: 999,
        resetAt: Date.now() - 1000, // Already expired
      });

      const allowed = checkRateLimit("expired-ip");
      assert.ok(allowed, "Should allow requests after window expires");
      assert.equal(rateLimitMap.get("expired-ip")!.count, 1, "Counter should reset");
    });
  });
});
