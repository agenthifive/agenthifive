import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { importJWK, jwtVerify, decodeJwt, calculateJwkThumbprint, type JWK } from "jose";
import { eq, and, gt, or, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "../db/schema/agents";
import { agentBootstrapSecrets } from "../db/schema/agent-bootstrap-secrets";
import { agentAccessTokens } from "../db/schema/agent-access-tokens";
import { checkAndStoreJti } from "../utils/jti-cache";
import {
  logAgentBootstrapped,
  logAgentBootstrapFailed,
  logAgentTokenIssued,
  logAgentTokenDenied,
} from "../services/audit";

const AGENT_TOKEN_TTL_SECONDS = Number(process.env["AGENT_TOKEN_TTL_SECONDS"]) || 7200; // 2 hours (was 15 min — too short for manual approvals)
// Accept both localhost and 127.0.0.1 variants to avoid audience mismatch
// when agents connect via different loopback addresses.
// Also accept WEB_URL (external-facing URL) since agents use that as their audience.
const _baseAudience = (process.env["AGENT_TOKEN_AUDIENCE"] || process.env["API_BASE_URL"] || "http://localhost:4000").replace(/\/+$/, "");
const AGENT_TOKEN_AUDIENCES: string[] = [_baseAudience];
if (_baseAudience.includes("localhost")) {
  AGENT_TOKEN_AUDIENCES.push(_baseAudience.replace("localhost", "127.0.0.1"));
} else if (_baseAudience.includes("127.0.0.1")) {
  AGENT_TOKEN_AUDIENCES.push(_baseAudience.replace("127.0.0.1", "localhost"));
}
const _webUrl = process.env["WEB_URL"]?.replace(/\/+$/, "");
if (_webUrl && !AGENT_TOKEN_AUDIENCES.includes(_webUrl)) {
  AGENT_TOKEN_AUDIENCES.push(_webUrl);
}
// Accept internal URL so agents connecting via private IP (e.g. 10.x.x.x:4000) don't fail audience checks
const _internalUrl = process.env["API_INTERNAL_URL"]?.replace(/\/+$/, "");
if (_internalUrl && !AGENT_TOKEN_AUDIENCES.includes(_internalUrl)) {
  AGENT_TOKEN_AUDIENCES.push(_internalUrl);
}

function isClockSkewAssertionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    /(exp|iat|nbf).*timestamp check failed/.test(normalized)
    || /timestamp check failed.*(exp|iat|nbf)/.test(normalized)
    || (normalized.includes("exp") && normalized.includes("expired"))
    || normalized.includes("not active yet")
  );
}

const errorResponse = {
  type: "object" as const,
  properties: { error: { type: "string" as const } },
};

const tokenErrorResponse = {
  type: "object" as const,
  properties: {
    error: { type: "string" as const },
    reason: { type: "string" as const },
    hint: { type: "string" as const },
  },
};

export default async function agentAuthRoutes(fastify: FastifyInstance) {
  fastify.log.info({ audiences: AGENT_TOKEN_AUDIENCES }, "agent-auth: configured token audiences");

  // ─── POST /agents/bootstrap ─────────────────────────────────────────

  fastify.post("/agents/bootstrap", {
    config: {
      skipAuth: true,
      rateLimit: { max: 5, timeWindow: "1 minute" },
    },
    schema: {
      tags: ["Agent Auth"],
      summary: "Bootstrap agent",
      description:
        "Consumes a bootstrap secret and registers the agent's ES256 public key. " +
        "For new agents (status 'created'), transitions to 'active'. " +
        "For active agents, replaces the public key and invalidates existing tokens.",
      security: [],
      body: {
        type: "object",
        required: ["bootstrapSecret", "publicKey"],
        properties: {
          bootstrapSecret: { type: "string", description: "Bootstrap secret (ah5b_ prefix)" },
          publicKey: {
            type: "object",
            description: "ES256 (P-256) public key in JWK format",
            properties: {
              kty: { type: "string" },
              crv: { type: "string" },
              x: { type: "string" },
              y: { type: "string" },
            },
            required: ["kty", "crv", "x", "y"],
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            agentId: { type: "string", format: "uuid" },
            name: { type: "string" },
            status: { type: "string" },
            workspaceId: { type: "string", format: "uuid" },
          },
        },
        400: errorResponse,
        401: errorResponse,
        409: errorResponse,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      bootstrapSecret: string;
      publicKey: { kty: string; crv: string; x: string; y: string };
    };

    request.log.info({ hasSecret: !!body.bootstrapSecret }, "agent.bootstrap.entry");

    if (!body.bootstrapSecret.startsWith("ah5b_")) {
      return reply.code(401).send({ error: "Invalid bootstrap secret" });
    }

    // Lookup secret — allow re-use within 1 hour of first consumption
    // so that network errors or failed follow-up steps don't permanently burn the key
    const secretHash = createHash("sha256").update(body.bootstrapSecret).digest("hex");
    const gracePeriodCutoff = new Date(Date.now() - 60 * 60 * 1000);
    const [secret] = await db
      .select({
        id: agentBootstrapSecrets.id,
        agentId: agentBootstrapSecrets.agentId,
      })
      .from(agentBootstrapSecrets)
      .where(
        and(
          eq(agentBootstrapSecrets.secretHash, secretHash),
          eq(agentBootstrapSecrets.type, "bootstrap"),
          or(isNull(agentBootstrapSecrets.consumedAt), gt(agentBootstrapSecrets.consumedAt, gracePeriodCutoff)),
          gt(agentBootstrapSecrets.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!secret) {
      logAgentBootstrapFailed({ reason: "Invalid or expired bootstrap secret" });
      return reply.code(401).send({ error: "Invalid or expired bootstrap secret" });
    }

    // Lookup agent
    const [agent] = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
        workspaceId: agents.workspaceId,
      })
      .from(agents)
      .where(eq(agents.id, secret.agentId))
      .limit(1);

    if (!agent) {
      return reply.code(401).send({ error: "Invalid or expired bootstrap secret" });
    }

    request.log.debug({ agentId: agent.id, agentStatus: agent.status }, "agent.bootstrap.found");

    if (agent.status === "disabled") {
      return reply.code(409).send({ error: "Agent is disabled" });
    }

    // Validate ES256 public key
    try {
      await importJWK(body.publicKey, "ES256");
    } catch {
      return reply.code(400).send({ error: "Invalid ES256 public key" });
    }

    const now = new Date();
    const previousStatus = agent.status;

    // Transaction: register/replace key, consume secret, optionally activate + invalidate tokens
    await db.transaction(async (tx) => {
      if (agent.status === "created") {
        // First enrollment: activate the agent
        await tx
          .update(agents)
          .set({
            status: "active",
            publicKeyJwk: body.publicKey,
            enrolledAt: now,
            updatedAt: now,
          })
          .where(eq(agents.id, agent.id));
      } else {
        // Re-keying: replace key and invalidate all existing tokens
        await tx
          .update(agents)
          .set({
            publicKeyJwk: body.publicKey,
            updatedAt: now,
          })
          .where(eq(agents.id, agent.id));

        await tx
          .delete(agentAccessTokens)
          .where(eq(agentAccessTokens.agentId, agent.id));
      }

      await tx
        .update(agentBootstrapSecrets)
        .set({ consumedAt: now })
        .where(eq(agentBootstrapSecrets.id, secret.id));
    });

    // Async audit
    const thumbprint = await calculateJwkThumbprint(body.publicKey, "sha256").catch(() => "unknown");
    logAgentBootstrapped(agent.id, { publicKeyThumbprint: thumbprint, previousStatus });

    request.log.info({ agentId: agent.id, previousStatus }, "agent.bootstrap.done");

    return {
      agentId: agent.id,
      name: agent.name,
      status: agent.status === "created" ? "active" : agent.status,
      workspaceId: agent.workspaceId,
    };
  });

  // ─── POST /agents/token ───────────────────────────────────────────

  fastify.post("/agents/token", {
    config: {
      skipAuth: true,
      rateLimit: { max: 30, timeWindow: "1 minute" },
    },
    schema: {
      tags: ["Agent Auth"],
      summary: "Exchange client assertion for access token",
      description:
        "Validates a signed client assertion JWT (ES256) against the agent's registered public key. " +
        "Returns a short-lived opaque access token.",
      security: [],
      body: {
        type: "object",
        required: ["grant_type", "client_assertion_type", "client_assertion"],
        properties: {
          grant_type: { type: "string", enum: ["client_assertion"] },
          client_assertion_type: {
            type: "string",
            enum: ["urn:ietf:params:oauth:client-assertion-type:jwt-bearer"],
          },
          client_assertion: { type: "string", description: "Signed ES256 JWT" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string", enum: ["Bearer"] },
            expires_in: { type: "number" },
          },
        },
        401: tokenErrorResponse,
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      grant_type: string;
      client_assertion_type: string;
      client_assertion: string;
    };

    request.log.info({ grantType: body.grant_type }, "agent.token.entry");

    if (body.grant_type !== "client_assertion") {
      return reply.code(401).send({ error: "Unsupported grant_type" });
    }
    if (body.client_assertion_type !== "urn:ietf:params:oauth:client-assertion-type:jwt-bearer") {
      return reply.code(401).send({ error: "Unsupported client_assertion_type" });
    }

    // Decode without verifying to read sub (agent ID)
    let agentId: string;
    try {
      const claims = decodeJwt(body.client_assertion);
      if (typeof claims.sub !== "string" || claims.sub.length === 0) {
        return reply.code(401).send({ error: "Missing sub claim in assertion" });
      }
      agentId = claims.sub;
    } catch {
      return reply.code(401).send({ error: "Malformed client assertion" });
    }

    // Lookup agent
    const [agent] = await db
      .select({
        id: agents.id,
        status: agents.status,
        publicKeyJwk: agents.publicKeyJwk,
        workspaceId: agents.workspaceId,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    request.log.debug({ agentId, found: !!agent, status: agent?.status ?? null }, "agent.token.lookup");

    if (!agent || agent.status !== "active" || !agent.publicKeyJwk) {
      logAgentTokenDenied(agentId, { reason: "Agent not found or not active" });
      return reply.code(401).send({ error: "Invalid agent or agent not active" });
    }

    // Import stored public key
    let publicKey;
    try {
      publicKey = await importJWK(agent.publicKeyJwk as JWK, "ES256");
    } catch (err) {
      request.log.error({ agentId, storedJwk: agent.publicKeyJwk, err }, "agent-token: stored public key invalid");
      logAgentTokenDenied(agentId, { reason: "Stored public key invalid" });
      return reply.code(401).send({ error: "Agent key configuration error" });
    }

    // Log stored key thumbprint for diagnostics
    const storedThumbprint = await calculateJwkThumbprint(agent.publicKeyJwk as JWK, "sha256").catch(() => "unknown");

    // Verify the assertion
    let payload;
    let decodedClaims: ReturnType<typeof decodeJwt> | null = null;
    try {
      decodedClaims = decodeJwt(body.client_assertion);
      request.log.debug(
        { agentId, storedKeyThumbprint: storedThumbprint.slice(0, 12), assertionAud: decodedClaims.aud, assertionIss: decodedClaims.iss, serverAudiences: AGENT_TOKEN_AUDIENCES },
        "agent-token: verifying assertion",
      );
      const result = await jwtVerify(body.client_assertion, publicKey, {
        algorithms: ["ES256"],
        issuer: agentId,
        audience: AGENT_TOKEN_AUDIENCES,
        clockTolerance: 5,
      });
      payload = result.payload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Verification failed";
      request.log.warn({ agentId, err: msg }, "agent-token: assertion verification failed");
      logAgentTokenDenied(agentId, { reason: msg });
      const now = Math.floor(Date.now() / 1000);
      const hasClockSkewClaims = decodedClaims !== null && (
        (typeof decodedClaims.exp === "number" && decodedClaims.exp <= now + 5)
        || (typeof decodedClaims.nbf === "number" && decodedClaims.nbf > now + 5)
        || (typeof decodedClaims.iat === "number" && decodedClaims.iat > now + 5)
      );
      if (isClockSkewAssertionError(msg) || hasClockSkewClaims) {
        return reply.code(401).send({
          error: "Invalid client assertion",
          reason: "clock_skew",
          hint: "System clock appears out of sync or the assertion expired before it reached the server.",
        });
      }
      return reply.code(401).send({ error: "Invalid client assertion" });
    }

    // Validate assertion lifetime (max 60s)
    const iat = payload.iat;
    const exp = payload.exp;
    if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > 60) {
      logAgentTokenDenied(agentId, { reason: "Assertion lifetime exceeds 60 seconds" });
      return reply.code(401).send({ error: "Assertion lifetime must be 60 seconds or less" });
    }

    // jti replay protection
    const jti = payload.jti;
    if (typeof jti !== "string" || jti.length === 0) {
      logAgentTokenDenied(agentId, { reason: "Missing jti claim" });
      return reply.code(401).send({ error: "Missing jti claim" });
    }

    const jtiAllowed = await checkAndStoreJti(jti, exp * 1000);
    request.log.debug({ jtiPrefix: jti.slice(0, 8), allowed: jtiAllowed }, "agent.token.jti");
    if (!jtiAllowed) {
      logAgentTokenDenied(agentId, { reason: "Replay detected" });
      return reply.code(401).send({ error: "Replay detected" });
    }

    // Generate opaque access token
    const accessToken = `ah5t_${randomBytes(32).toString("base64url")}`;
    const tokenHash = createHash("sha256").update(accessToken).digest("hex");
    const expiresAt = new Date(Date.now() + AGENT_TOKEN_TTL_SECONDS * 1000);

    await db.insert(agentAccessTokens).values({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      tokenHash,
      expiresAt,
    });

    logAgentTokenIssued(agent.id, { tokenTtlSeconds: AGENT_TOKEN_TTL_SECONDS });

    request.log.info({ agentId: agent.id, ttl: AGENT_TOKEN_TTL_SECONDS }, "agent.token.issued");

    return {
      access_token: accessToken,
      token_type: "Bearer" as const,
      expires_in: AGENT_TOKEN_TTL_SECONDS,
    };
  });
}
