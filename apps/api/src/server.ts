import { Sentry } from "./instrument";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { randomBytes, timingSafeEqual } from "node:crypto";
import jwtAuth from "./plugins/jwt-auth";
import { setAuditLogger } from "./services/audit";
import { setEmailLogger } from "./services/email";
import { setExternalNotificationLogger } from "./services/external-notifications";
import { setPushNotificationLogger } from "./services/push-notifications";
import workspaceRoutes from "./routes/workspaces";
import connectionRoutes from "./routes/connections";
import agentRoutes from "./routes/agents";
import policyRoutes from "./routes/policies";
import vaultRoutes from "./routes/vault";
import approvalRoutes from "./routes/approvals";
import auditRoutes from "./routes/audit";
import activityRoutes from "./routes/activity";
import templateRoutes from "./routes/templates";
import dashboardRoutes from "./routes/dashboard";
import tokenRoutes from "./routes/tokens";
import credentialRoutes from "./routes/credentials";
import agentPermissionRequestsRoutes from "./routes/agent-permission-requests";
import capabilityRoutes from "./routes/capabilities";
import notificationRoutes from "./routes/notifications";
import agentAuthRoutes from "./routes/agent-auth";
import userAuthRoutes from "./routes/user-auth";
import userTokenRoutes from "./routes/user-token";
import workspaceOauthAppRoutes from "./routes/workspace-oauth-apps";
import notificationChannelRoutes from "./routes/notification-channels";
import quickActionRoutes from "./routes/quick-actions";
import { startJtiCleanup } from "./utils/jti-cache";
import { startTokenCleanup } from "./utils/token-cleanup";
import { startApprovalScrub } from "./utils/approval-scrub";
import { startListeners } from "./services/pg-listeners";
import { initEncryptionKey } from "./services/encryption-key";


const PORT = Number(process.env["API_PORT"]) || 8080;
const WEB_URL = process.env["WEB_URL"] || "http://localhost:3000";
const API_BIND_HOST = process.env["API_BIND_HOST"] || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";

async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env["LOG_LEVEL"] || "info",
      ...(isProduction
        ? { timestamp: () => `,"time":"${new Date().toISOString()}"` }
        : {
            transport: {
              target: "pino-pretty",
              options: {
                translateTime: "SYS:HH:MM:ss.l",
                ignore: "pid,hostname",
                singleLine: true,
              },
            },
          }),
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers["x-api-key"]',
          "*.accessToken", "*.refreshToken", "*.botToken", "*.apiKey", "*.appKey",
          "*.client_secret", "*.password", "*.encryptedTokens",
          "*.bootstrapSecret", "*.client_assertion", "*.tokenHash", "*.secretHash",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 1_048_576, // 1 MB
    requestTimeout: 30_000, // 30 seconds
    trustProxy: true, // behind nginx — trust X-Forwarded-For for correct client IP
    ignoreTrailingSlash: true, // NPM (openresty) adds trailing slash redirects — accept both forms
  });

  // Set service loggers to Fastify's Pino logger
  setAuditLogger(app.log);
  setEmailLogger(app.log);
  setExternalNotificationLogger(app.log);
  setPushNotificationLogger(app.log);

  // Global error handler — guarantee no stack trace leakage
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log.error(error);
    const statusCode = error.statusCode ?? 500;
    // Report 5xx errors to Sentry (4xx are expected client errors)
    if (statusCode >= 500) {
      Sentry.captureException(error);
    }
    reply.code(statusCode).send({
      error: statusCode >= 500 ? "Internal server error" : error.message,
      ...((error as Error & { hint?: string }).hint && statusCode < 500 && { hint: (error as Error & { hint?: string }).hint }),
    });
  });

  // Sentry Fastify integration — captures unhandled errors with request context
  Sentry.setupFastifyErrorHandler(app);

  // OpenAPI / Swagger documentation — register BEFORE routes
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "AgentHiFive API",
        description:
          "Authority delegation platform for AI agents. " +
          "Provides OAuth connection management, policy-based access control, " +
          "execution gateway (Model A: token vending, Model B: brokered proxy), " +
          "step-up approvals, and comprehensive audit logging.",
        version: "1.0.0",
      },
      servers: [
        {
          url: `http://localhost:${PORT}`,
          description: "Local development",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description:
              "JWT obtained from POST /api/auth/token on the web app. " +
              "The token contains claims: sub (userId), wid (workspaceId), roles, scp (scopes), sid (sessionId). " +
              "TTL is 5 minutes. The JWKS endpoint at /.well-known/jwks.json on the web app serves the public key.",
          },
          apiKey: {
            type: "apiKey",
            in: "header",
            name: "X-API-Key",
            description:
              "Personal access token for API authentication. " +
              "Generate from Settings → API Tokens. Tokens use the prefix 'ah5p_' and are shown only once on creation.",
          },
          agentToken: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "opaque",
            description:
              "Agent access token (ah5t_ prefix) obtained via POST /v1/agents/token " +
              "using a signed ES256 client assertion (private_key_jwt). Short-lived (default 15 min).",
          },
        },
      },
      security: [{ bearerAuth: [] }, { apiKey: [] }, { agentToken: [] }],
      tags: [
        { name: "Health", description: "Health check endpoint" },
        { name: "Workspaces", description: "Workspace/tenant management" },
        { name: "Connections", description: "OAuth connection lifecycle — initiation, callback, revocation, reauth" },
        { name: "Agents", description: "Agent/app registration and management" },
        { name: "Policies", description: "Policy binding — allowlists, rate limits, time windows" },
        { name: "Vault", description: "Execution gateway — Model A (token vending) and Model B (brokered proxy)" },
        { name: "Approvals", description: "Step-up approval workflow for sensitive actions" },
        { name: "Audit", description: "Audit event querying and export" },
        { name: "Activity", description: "Human-readable activity feed" },
        { name: "Templates", description: "Provider allowlist templates" },
        { name: "Dashboard", description: "Dashboard summary statistics" },
        { name: "Tokens", description: "Personal access token management" },
        { name: "Agent Permission Requests", description: "Agent permission request workflow — pending requests for action access" },
        { name: "Capabilities", description: "Capability discovery — list available services and agent's current access status" },
        { name: "Notifications", description: "In-app notifications with real-time SSE push" },
        { name: "Agent Auth", description: "Agent onboarding — enrollment, key rotation (reattach), and token exchange via client assertions" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
  });

  // CORS — allow requests from apps/web only
  await app.register(cors, {
    origin: WEB_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Authorization", "Content-Type", "X-API-Key"],
    maxAge: 3600,
  });

  // Cookie parsing for sticky session affinity
  await app.register(cookie);

  // Global rate limiting per IP (safety net — real abuse protection is at WAF/Front Door).
  // NOTE: Per-replica counters. Effective limit = N × max with N replicas.
  // Per-agent rate limits enforced in policy engine (DB-backed, consistent).
  await app.register(rateLimit, {
    max: process.env.NODE_ENV === "production" ? 1000 : 5000,
    timeWindow: "15 minutes",
    allowList: (req) => {
      const ip = req.ip;
      // Localhost health probes
      if (ip === "127.0.0.1" || ip === "::1") return true;
      // Health endpoints should never be rate limited
      if (req.url === "/health" || req.url === "/v1/health") return true;
      return false;
    },
  });

  // Gate: optional basic auth for non-prod environments.
  // Set BASIC_AUTH_PASSWORD in env/Key Vault to enable.
  const basicAuthPassword = process.env["BASIC_AUTH_PASSWORD"];
  if (basicAuthPassword) {
    const expected = Buffer.from(`ah5:${basicAuthPassword}`);
    app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/health" || request.url === "/v1/health") return;

      // Let through any request that carries its own auth credentials.
      // Validity is checked downstream by jwt-auth plugin — here we only
      // gate requests that have NO auth at all (casual browsers, crawlers).
      const auth = request.headers.authorization ?? "";
      if (auth.startsWith("Bearer ") || auth.startsWith("Basic ")) {
        // Basic creds still need to be verified right here
        if (auth.startsWith("Basic ")) {
          const decoded = Buffer.from(auth.slice(6), "base64");
          if (decoded.length === expected.length && timingSafeEqual(decoded, expected)) return;
          // Bad Basic creds — fall through to 401
        } else {
          return; // Bearer — jwt-auth validates downstream
        }
      } else if (
        request.headers["x-api-key"] ||                               // PAT / agent token via header
        request.headers["x-goog-api-key"] ||                          // Gemini SDK sends API-key auth here
        request.url.startsWith("/api/auth/") ||                       // Better Auth (session cookies)
        request.url.startsWith("/.well-known/") ||                    // JWKS, OpenID config
        request.url.startsWith("/v1/agents/bootstrap") ||             // body-based auth (bootstrap secret)
        request.url.startsWith("/v1/agents/token") ||                 // body-based auth (client assertion)
        request.url.startsWith("/api/quick-action/")                   // path token (email/Telegram approval links)
      ) {
        return;
      }

      void reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="AgentHiFive"')
        .send({ error: "Unauthorized" });
    });
    app.log.info("Basic auth gate enabled (user: ah5)");
  }

  // Gate: reject requests that bypass Azure Front Door.
  // AZURE_FRONT_DOOR_ID is set by OpenTofu from the FD profile resource_guid.
  const azureFdId = process.env["AZURE_FRONT_DOOR_ID"];
  if (azureFdId) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url === "/health" || request.url === "/v1/health") return;
      // Allow internal JWKS fetch (createRemoteJWKSet from localhost)
      if (request.url.startsWith("/.well-known/")) return;
      const fdId = request.headers["x-azure-fdid"];
      if (fdId === azureFdId) return;
      void reply.code(403).send({ error: "Forbidden" });
    });
    app.log.info("Front Door ID validation enabled");
  }

  // JWT auth plugin — decorates request.user on authenticated routes
  await app.register(jwtAuth);

  // Set sticky session cookie if not present (for load balancer consistent hashing)
  app.addHook("onSend", async (request, reply) => {
    if (request.cookies?.ah5sid) return;
    // Skip health checks and preflight requests
    if (request.url === "/health" || request.url === "/v1/health" || request.method === "OPTIONS") return;
    const sessionId = randomBytes(16).toString("base64url");
    void reply.setCookie("ah5sid", sessionId, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      maxAge: 86400 * 30, // 30 days
      path: "/",
    });
  });

  // Debug-level request/response tracing (LOG_LEVEL=debug to enable)
  app.addHook("onRequest", async (request) => {
    if (request.url === "/health" || request.url === "/v1/health") return;
    const authHeader = request.headers.authorization ?? "";
    request.log.debug(
      {
        method: request.method,
        url: request.url,
        contentLength: request.headers["content-length"],
        ip: request.ip,
        authType: authHeader.startsWith("Bearer ah5t_") ? "agent-token"
          : authHeader.startsWith("Bearer ah5p_") ? "pat-bearer"
          : authHeader.startsWith("Bearer ") ? "jwt"
          : request.headers["x-api-key"] ? "api-key"
          : "none",
      },
      "req.in",
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    if (request.url === "/health" || request.url === "/v1/health") return;
    request.log.debug(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime),
      },
      "req.out",
    );
  });

  // Start jti replay cache cleanup (agent client assertion replay protection)
  startJtiCleanup(app.log);

  // Start periodic cleanup of expired agent access tokens and consumed bootstrap secrets
  startTokenCleanup(app.log);

  // Start periodic scrub of sensitive metadata from resolved approval requests
  startApprovalScrub(app.log);

  // Start PostgreSQL LISTEN/NOTIFY for cross-replica SSE push and policy cache invalidation
  await startListeners(app.log);

  // Health check — skips JWT auth
  app.get(
    "/health",
    {
      config: { skipAuth: true },
      schema: {
        tags: ["Health"],
        summary: "Health check",
        description: "Returns server health status. Does not require authentication.",
        security: [],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", enum: ["ok"] },
            },
          },
        },
      },
    },
    async () => {
      return { status: "ok" };
    },
  );

  // Initialize encryption key (env var in dev, Azure Key Vault unwrap in production)
  await initEncryptionKey();

  // User auth routes — Better Auth handler, JWKS, OAuth callback, token exchange
  // Registered before /v1 routes (they use /api/auth/*, /.well-known/*, /api/connections/callback)
  await app.register(userAuthRoutes);
  await app.register(userTokenRoutes);

  // Routes — all under /v1 prefix
  await app.register(
    async function v1Routes(v1) {
      // Health check (also available at /health without prefix for Docker healthcheck)
      v1.get("/health", { config: { skipAuth: true }, schema: { tags: ["Health"], security: [] } }, async () => ({ status: "ok" }));

      // Build version info
      v1.get(
        "/version",
        {
          config: { skipAuth: true },
          schema: {
            tags: ["Health"],
            summary: "Build version info",
            description: "Returns build number, date, and git SHA. Does not require authentication.",
            security: [],
            response: {
              200: {
                type: "object",
                properties: {
                  buildNumber: { type: "string" },
                  buildDate: { type: "string" },
                  gitSha: { type: "string" },
                },
              },
            },
          },
        },
        async () => ({
          buildNumber: process.env["BUILD_NUMBER"] ?? "dev",
          buildDate: process.env["BUILD_DATE"] ?? "unknown",
          gitSha: process.env["GIT_SHA"] ?? "unknown",
        }),
      );

      await v1.register(workspaceRoutes);
      await v1.register(connectionRoutes);
      await v1.register(agentRoutes);
      await v1.register(policyRoutes);
      await v1.register(vaultRoutes);
      await v1.register(approvalRoutes);
      await v1.register(auditRoutes);
      await v1.register(activityRoutes);
      await v1.register(templateRoutes);
      await v1.register(dashboardRoutes);
      await v1.register(tokenRoutes);
      await v1.register(credentialRoutes);
      await v1.register(agentPermissionRequestsRoutes);
      await v1.register(capabilityRoutes);
      await v1.register(notificationRoutes);
      await v1.register(agentAuthRoutes);
      await v1.register(workspaceOauthAppRoutes);
      await v1.register(notificationChannelRoutes);
    },
    { prefix: "/v1" },
  );

  // Quick-action routes live under /api/ (not /v1/) so they work on proxies
  // that only forward /api/* (integration machines, etc.)
  await app.register(quickActionRoutes, { prefix: "/api" });

  return app;
}

/**
 * Start the Fastify server. Accepts an optional pre-built app instance
 * so that the enterprise overlay can extend buildApp() before starting.
 */
async function startServer(app?: Awaited<ReturnType<typeof buildApp>>) {
  const instance = app ?? (await buildApp());

  try {
    await instance.listen({ port: PORT, host: API_BIND_HOST });
  } catch (err) {
    instance.log.error(err);
    process.exit(1);
  }

  return instance;
}

export { buildApp, startServer };

// Auto-start only when run directly (not when imported by enterprise overlay)
const entryUrl = new URL(process.argv[1]!, "file://");
if (import.meta.url === entryUrl.href) {
  startServer();
}
