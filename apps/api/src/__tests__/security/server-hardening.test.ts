import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

/**
 * Tests for server-level security hardening:
 * - Global error handler (no stack trace leakage)
 * - CORS configuration (origin, methods, headers)
 * - Rate limiting (429 after threshold)
 *
 * These mirror the configuration in apps/api/src/server.ts.
 */
describe("Server Hardening", () => {
  // ── Error Handler ─────────────────────────────────────────────────

  describe("Global Error Handler", () => {
    let app: FastifyInstance;

    before(async () => {
      app = Fastify({
        logger: false,
        bodyLimit: 1_048_576,
        requestTimeout: 30_000,
      });

      // Replicate the error handler from server.ts
      app.setErrorHandler(
        (error: Error & { statusCode?: number }, _request, reply) => {
          const statusCode = error.statusCode ?? 500;
          reply.code(statusCode).send({
            error:
              statusCode >= 500 ? "Internal server error" : error.message,
          });
        },
      );

      // Route that throws a 500 with sensitive info
      app.get("/throw-500", async () => {
        throw new Error(
          "FATAL: connection to postgres://admin:s3cret@db:5432/prod failed",
        );
      });

      // Route that throws a 400 with a client-facing message
      app.get("/throw-400", async () => {
        const err = new Error("Missing required field 'name'");
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      });

      // Route that throws a 403
      app.get("/throw-403", async () => {
        const err = new Error("Insufficient permissions for this resource");
        (err as Error & { statusCode?: number }).statusCode = 403;
        throw err;
      });

      await app.ready();
    });

    after(async () => {
      await app.close();
    });

    it("returns generic message for 500 errors — never leaks stack trace", async () => {
      const res = await app.inject({ method: "GET", url: "/throw-500" });

      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Internal server error");
      // Must not leak DB credentials or internal details
      assert.ok(
        !res.body.includes("s3cret"),
        "Must not leak sensitive data in response body",
      );
      assert.ok(
        !res.body.includes("postgres://"),
        "Must not leak connection strings",
      );
      assert.ok(!body.stack, "Must not include stack trace");
      assert.ok(!body.message, "Must not include raw error message");
    });

    it("passes through client error messages for 400", async () => {
      const res = await app.inject({ method: "GET", url: "/throw-400" });

      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Missing required field 'name'");
    });

    it("passes through client error messages for 403", async () => {
      const res = await app.inject({ method: "GET", url: "/throw-403" });

      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Insufficient permissions for this resource");
    });

    it("defaults to 500 when error has no statusCode", async () => {
      const res = await app.inject({ method: "GET", url: "/throw-500" });

      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.equal(body.error, "Internal server error");
    });
  });

  // ── CORS ──────────────────────────────────────────────────────────

  describe("CORS Configuration", () => {
    let app: FastifyInstance;
    const ALLOWED_ORIGIN = "http://localhost:3000";

    before(async () => {
      app = Fastify({ logger: false });

      // Replicate CORS config from server.ts
      await app.register(cors, {
        origin: ALLOWED_ORIGIN,
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
        allowedHeaders: ["Authorization", "Content-Type", "X-API-Key"],
        maxAge: 3600,
      });

      app.get("/api-endpoint", async () => ({ data: "ok" }));

      await app.ready();
    });

    after(async () => {
      await app.close();
    });

    it("sets Access-Control-Allow-Origin for configured origin", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
        },
      });

      assert.equal(
        res.headers["access-control-allow-origin"],
        ALLOWED_ORIGIN,
      );
    });

    it("does NOT set Access-Control-Allow-Origin for unauthorized origins", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: "https://evil.example.com",
          "access-control-request-method": "GET",
        },
      });

      // @fastify/cors omits ACAO header for non-matching origins
      assert.notEqual(
        res.headers["access-control-allow-origin"],
        "https://evil.example.com",
      );
    });

    it("does NOT reflect arbitrary origins (no wildcard)", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: "https://attacker.com",
          "access-control-request-method": "GET",
        },
      });

      assert.notEqual(
        res.headers["access-control-allow-origin"],
        "https://attacker.com",
      );
      assert.notEqual(res.headers["access-control-allow-origin"], "*");
    });

    it("includes credentials support", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
        },
      });

      assert.equal(res.headers["access-control-allow-credentials"], "true");
    });

    it("allows only safe HTTP methods", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "POST",
        },
      });

      const methods = res.headers["access-control-allow-methods"] as string;
      assert.ok(methods.includes("GET"), "GET should be allowed");
      assert.ok(methods.includes("POST"), "POST should be allowed");
      assert.ok(methods.includes("PUT"), "PUT should be allowed");
      assert.ok(methods.includes("DELETE"), "DELETE should be allowed");
      assert.ok(methods.includes("PATCH"), "PATCH should be allowed");
      // TRACE and OPTIONS should not be in the explicit list
      assert.ok(!methods.includes("TRACE"), "TRACE must not be allowed");
    });

    it("restricts allowed headers to Authorization, Content-Type, X-API-Key", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
          "access-control-request-headers": "Authorization",
        },
      });

      const headers = res.headers["access-control-allow-headers"] as string;
      assert.ok(headers.includes("Authorization"));
      assert.ok(headers.includes("Content-Type"));
      assert.ok(headers.includes("X-API-Key"));
    });

    it("sets max-age for preflight caching", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/api-endpoint",
        headers: {
          origin: ALLOWED_ORIGIN,
          "access-control-request-method": "GET",
        },
      });

      assert.equal(res.headers["access-control-max-age"], "3600");
    });
  });

  // ── Rate Limiting ─────────────────────────────────────────────────

  describe("Rate Limiting", () => {
    it("returns 429 when rate limit is exceeded", async () => {
      const app = Fastify({ logger: false });
      await app.register(rateLimit, {
        max: 3, // Low limit for fast testing
        timeWindow: "1 minute",
      });
      app.get("/endpoint", async () => ({ ok: true }));
      await app.ready();

      // Send requests up to the limit
      for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: "GET", url: "/endpoint" });
        assert.equal(res.statusCode, 200, `Request ${i + 1} should succeed`);
      }

      // Next request should be rate limited
      const res = await app.inject({ method: "GET", url: "/endpoint" });
      assert.equal(res.statusCode, 429);
      const body = JSON.parse(res.body);
      assert.ok(body.message || body.error, "Rate limit response should have a message");

      await app.close();
    });

    it("includes X-RateLimit headers in responses", async () => {
      const app = Fastify({ logger: false });
      await app.register(rateLimit, {
        max: 10,
        timeWindow: "1 minute",
      });
      app.get("/endpoint", async () => ({ ok: true }));
      await app.ready();

      const res = await app.inject({ method: "GET", url: "/endpoint" });

      assert.equal(res.statusCode, 200);
      assert.ok(
        res.headers["x-ratelimit-limit"],
        "Should include x-ratelimit-limit header",
      );
      assert.ok(
        res.headers["x-ratelimit-remaining"],
        "Should include x-ratelimit-remaining header",
      );

      await app.close();
    });

    it("tracks rate limits per-IP (simulated via different client addresses)", async () => {
      const app = Fastify({ logger: false, trustProxy: true });
      await app.register(rateLimit, {
        max: 2,
        timeWindow: "1 minute",
      });
      app.get("/endpoint", async () => ({ ok: true }));
      await app.ready();

      // Client A: exhaust limit
      for (let i = 0; i < 2; i++) {
        await app.inject({
          method: "GET",
          url: "/endpoint",
          headers: { "x-forwarded-for": "10.0.0.1" },
        });
      }
      const resA = await app.inject({
        method: "GET",
        url: "/endpoint",
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      assert.equal(resA.statusCode, 429, "Client A should be rate limited");

      // Client B: should still have budget
      const resB = await app.inject({
        method: "GET",
        url: "/endpoint",
        headers: { "x-forwarded-for": "10.0.0.2" },
      });
      assert.equal(resB.statusCode, 200, "Client B should not be affected by A's limit");

      await app.close();
    });
  });

  // ── Fastify Init Options ──────────────────────────────────────────

  describe("Fastify Configuration", () => {
    it("rejects request bodies exceeding bodyLimit", async () => {
      const app = Fastify({
        logger: false,
        bodyLimit: 1024, // 1 KB for testing
      });

      app.post("/upload", async (request) => {
        return { received: typeof request.body };
      });

      await app.ready();

      // Send a body larger than 1 KB
      const largeBody = JSON.stringify({ data: "x".repeat(2048) });

      const res = await app.inject({
        method: "POST",
        url: "/upload",
        headers: { "content-type": "application/json" },
        body: largeBody,
      });

      assert.equal(res.statusCode, 413, "Should reject oversized body with 413");

      await app.close();
    });

    it("has trustProxy enabled for correct client IP behind nginx", async () => {
      const app = Fastify({ logger: false, trustProxy: true });

      app.get("/ip", async (request) => {
        return { ip: request.ip };
      });

      await app.ready();

      const res = await app.inject({
        method: "GET",
        url: "/ip",
        headers: { "x-forwarded-for": "203.0.113.42" },
      });

      const body = JSON.parse(res.body);
      assert.equal(
        body.ip,
        "203.0.113.42",
        "Should use X-Forwarded-For as client IP when trustProxy is enabled",
      );

      await app.close();
    });
  });
});
