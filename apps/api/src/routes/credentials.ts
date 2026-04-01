import type { FastifyInstance } from "fastify";
import { reply500 } from "../utils/reply-error";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db/client";
import { connections } from "../db/schema/connections";
import { providerEnum, serviceEnum } from "../db/schema/enums";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";
import { markConnectionNeedsReauth } from "./connections";
import { resolveConnector } from "../utils/oauth-connector-factory";
import { logEvent } from "../services/audit";
import { refreshAnthropicToken } from "../utils/anthropic-oauth";

import { getEncryptionKey } from "../services/encryption-key";

type Provider = (typeof providerEnum.enumValues)[number];
type Service = (typeof serviceEnum.enumValues)[number];

/**
 * Map an OpenClaw provider name to an AgentHiFive OAuth provider.
 * OpenClaw uses names like "google", "openai", "anthropic", "msteams";
 * AgentHiFive uses "google", "microsoft", "telegram", "slack", "openai", "gemini".
 *
 * Kind-aware: OpenClaw uses "google" for both Google Workspace (OAuth) and
 * Google Gemini (API key). When kind=model_provider, "google" maps to "gemini".
 */
function mapProvider(provider: string, kind?: string): Provider | null {
  // Model provider queries: "google" means Gemini (the LLM), not Google Workspace OAuth
  if (kind === "model_provider") {
    const mapping: Record<string, Provider> = {
      google: "gemini",
      gemini: "gemini",
      openai: "openai",
      anthropic: "anthropic",
      openrouter: "openrouter",
    };
    return mapping[provider] ?? null;
  }

  const mapping: Record<string, Provider> = {
    google: "google",
    microsoft: "microsoft",
    msteams: "microsoft",
    telegram: "telegram",
    slack: "slack",
    github: "github",
    anthropic: "anthropic",
    openai: "openai",
    gemini: "gemini",
    openrouter: "openrouter",
    notion: "notion",
  };
  return mapping[provider] ?? null;
}

/**
 * Map an OpenClaw provider name to a preferred service filter.
 * Used when multiple services share the same OAuth provider (e.g., google-gmail vs google-drive).
 */
function mapService(provider: string): Service | null {
  const mapping: Record<string, Service> = {
    msteams: "microsoft-teams",
  };
  return mapping[provider] ?? null;
}

export default async function credentialRoutes(fastify: FastifyInstance) {
  /**
   * POST /credentials/resolve
   *
   * Resolve a credential from the vault. Called by the OpenClaw fork's
   * VaultCredentialProvider to fetch API keys, OAuth tokens, or bot tokens.
   *
   * Lookup strategy:
   * - If profileId is a UUID: direct connection lookup by ID
   * - Otherwise: search by provider name, optionally filtered by service
   *
   * Returns 404 when no matching credential is found (signals "fall through to local").
   */
  fastify.post("/credentials/resolve", {
    schema: {
      tags: ["Vault"],
      summary: "Resolve a credential from the vault",
      description:
        "Resolve a credential for a given provider. Used by external agent frameworks " +
        "(e.g., OpenClaw) to delegate credential storage to AgentHiFive.\n\n" +
        "Returns the decrypted credential (access token, API key, or bot token). " +
        "If an OAuth token is expired, it is refreshed automatically before returning.\n\n" +
        "Returns 404 when no matching credential is found — the caller should fall back to local credentials.",
      body: {
        type: "object",
        required: ["kind", "provider"],
        properties: {
          kind: {
            type: "string",
            enum: ["model_provider", "channel", "plugin_config"],
            description: "What type of credential is being requested",
          },
          provider: {
            type: "string",
            description: "Provider identifier (e.g., 'openai', 'telegram', 'msteams', 'slack')",
          },
          profileId: {
            type: "string",
            description: "Optional connection ID (UUID) or profile identifier for multi-account setups",
          },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Optional hint about which credential fields are needed",
          },
        },
      },
      response: {
        200: {
          description: "Credential resolved successfully",
          type: "object",
          properties: {
            apiKey: { type: "string", description: "Primary credential value" },
            extra: {
              type: "object",
              additionalProperties: { type: "string" },
              description: "Additional credential fields (e.g., appToken, tenantId)",
            },
            source: { type: "string", description: "Source description for audit/debugging" },
            mode: { type: "string", enum: ["api-key", "oauth", "token", "aws-sdk"] },
            cacheTtlMs: { type: "number", description: "Suggested local cache TTL in milliseconds" },
          },
          required: ["apiKey", "source"],
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        403: { type: "object", properties: { error: { type: "string" }, hint: { type: "string" } } },
        404: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { sub, wid, agentId } = request.user;
    const body = request.body as {
      kind: string;
      provider: string;
      profileId?: string;
      fields?: string[];
    };

    request.log.debug(
      { kind: body.kind, provider: body.provider, profileId: body.profileId ?? null, agentId: agentId ?? null },
      "cred.entry",
    );

    // Agents use vault/execute with model "A" (token vending) or "B" (brokered proxy).
    // credentials/resolve is for admin/dashboard use only.
    if (agentId) {
      request.log.warn({ agentId, kind: body.kind, provider: body.provider }, "cred.agent.blocked");
      return reply.code(403).send({
        error: "Agents cannot access credentials/resolve directly.",
        hint: "Use POST /v1/vault/execute with model: \"A\" for token vending or model: \"B\" for brokered proxy.",
      });
    }

    if (!body.kind || !body.provider) {
      return reply.code(400).send({ error: "kind and provider are required" });
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    // --- Connection lookup ---
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.profileId ?? "");

    let connection: {
      id: string;
      provider: string;
      service: string;
      status: string;
      encryptedTokens: string | null;
      metadata: unknown;
      oauthAppId: string | null;
      workspaceId: string;
    } | undefined;

    if (isUuid && body.profileId) {
      // Direct lookup by connection ID
      const [row] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, body.profileId),
            eq(connections.workspaceId, wid),
          ),
        )
        .limit(1);
      connection = row;
    } else {
      // Lookup by provider name
      const mappedProvider = mapProvider(body.provider, body.kind);
      if (!mappedProvider) {
        request.log.debug({ rawProvider: body.provider, kind: body.kind }, "cred.mapped.unknown");
        return reply.code(404).send({ error: `No credential found for provider: ${body.provider}` });
      }

      const mappedService = mapService(body.provider);

      request.log.debug(
        { rawProvider: body.provider, mappedProvider, mappedService: mappedService ?? "none" },
        "cred.mapped",
      );

      // Find the first healthy connection matching the provider (and optionally service)
      const query = db
        .select()
        .from(connections)
        .where(
          mappedService
            ? and(
                eq(connections.provider, mappedProvider),
                eq(connections.service, mappedService),
                eq(connections.workspaceId, wid),
                eq(connections.status, "healthy"),
              )
            : and(
                eq(connections.provider, mappedProvider),
                eq(connections.workspaceId, wid),
                eq(connections.status, "healthy"),
              ),
        )
        .orderBy(desc(connections.createdAt))
        .limit(1);

      const [row] = await query;
      connection = row;
    }

    if (!connection) {
      request.log.debug({ provider: body.provider, profileId: body.profileId ?? null }, "cred.connection.notFound");
      return reply.code(404).send({ error: `No credential found for provider: ${body.provider}` });
    }

    request.log.debug(
      { connectionId: connection.id, provider: connection.provider, service: connection.service, status: connection.status },
      "cred.connection",
    );

    if (connection.status === "revoked" || connection.status === "needs_reauth") {
      return reply.code(404).send({ error: `Connection is ${connection.status}` });
    }

    // --- Decrypt tokens ---
    if (!connection.encryptedTokens) {
      return reply.code(404).send({ error: "Connection tokens have been revoked" });
    }

    let tokenData: {
      accessToken?: string;
      refreshToken?: string;
      tokenType?: string;
      expiresAt?: string | number;
      botToken?: string;
      apiKey?: string;
    };
    try {
      const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
      const decrypted = decrypt(encryptedPayload, getEncryptionKey());
      tokenData = JSON.parse(decrypted);
    } catch (err) {
      return reply500(reply, err, "Failed to decrypt connection tokens", { request, extra: { connectionId: connection.id } });
    }

    // --- Resolve the credential based on provider type ---

    // Telegram: return bot token directly
    if (connection.provider === "telegram") {
      request.log.debug({ tokenType: "bot", provider: connection.provider }, "cred.tokenType");

      if (!tokenData.botToken) {
        return reply500(reply, new Error("Telegram bot token not found"), "Telegram bot token not found", { request, extra: { connectionId: connection.id } });
      }

      logEvent({
        actor: sub,
        agentId: agentId ?? null,
        connectionId: connection.id,
        action: "credential_resolved",
        decision: "allowed",
        metadata: { kind: body.kind, provider: body.provider, mode: "token" },
      });

      request.log.debug({ provider: connection.provider, mode: "token", cacheTtlMs: 300_000 }, "cred.resolved");

      return {
        apiKey: tokenData.botToken,
        source: `vault:${connection.provider}:${connection.id}`,
        mode: "token" as const,
        cacheTtlMs: 300_000, // 5 min — bot tokens don't expire but we want periodic re-check
      };
    }

    // Anthropic: static API key or OAuth tokens (with auto-refresh)
    if (connection.provider === "anthropic") {
      let resolvedKey: string;
      let mode: "api-key" | "oauth";

      if (tokenData.apiKey) {
        // Static API key — use directly
        request.log.debug({ tokenType: "api-key", provider: connection.provider }, "cred.tokenType");
        resolvedKey = tokenData.apiKey;
        mode = "api-key";
      } else if (tokenData.refreshToken) {
        request.log.debug({ tokenType: "oauth", provider: connection.provider }, "cred.tokenType");

        // OAuth tokens — refresh if expired or expiring within 60s
        let accessToken = tokenData.accessToken;
        const expiresAt = tokenData.expiresAt ? new Date(tokenData.expiresAt).getTime() : 0;

        if (!accessToken || expiresAt < Date.now() + 60_000) {
          try {
            request.log.debug({ provider: connection.provider, reason: "expired_or_expiring" }, "cred.refresh");
            request.log.info({ connectionId: connection.id }, "Refreshing Anthropic OAuth token");
            const newTokens = await refreshAnthropicToken(tokenData.refreshToken);
            accessToken = newTokens.accessToken;

            // Persist refreshed tokens (fire-and-forget)
            const { encrypt } = await import("@agenthifive/security");
            const updatedPayload = JSON.stringify({
              accessToken: newTokens.accessToken,
              refreshToken: newTokens.refreshToken,
              expiresAt: newTokens.expiresAt,
            });
            const encrypted = JSON.stringify(encrypt(updatedPayload, getEncryptionKey()));
            db.update(connections)
              .set({ encryptedTokens: encrypted, updatedAt: new Date() })
              .where(eq(connections.id, connection.id))
              .then(() => {})
              .catch((err) => request.log.error(err, "Failed to persist refreshed Anthropic tokens"));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Anthropic token refresh failed";
            request.log.warn({ err, connectionId: connection.id }, message);
            await markConnectionNeedsReauth(connection.id, message, request.log);
            return reply.code(404).send({ error: "Anthropic connection requires reauthentication" });
          }
        }

        resolvedKey = accessToken!;
        mode = "oauth";
      } else {
        return reply500(reply, new Error("Anthropic API key not found in connection"), "Anthropic API key not found in connection", { request, extra: { connectionId: connection.id } });
      }

      logEvent({
        actor: sub,
        agentId: agentId ?? null,
        connectionId: connection.id,
        action: "credential_resolved",
        decision: "allowed",
        metadata: { kind: body.kind, provider: body.provider, mode },
      });

      const cacheTtlMs = mode === "api-key" ? 300_000 : 60_000;
      request.log.debug({ provider: connection.provider, mode, cacheTtlMs }, "cred.resolved");

      return {
        apiKey: resolvedKey,
        source: `vault:${connection.provider}:${connection.id}`,
        mode,
        cacheTtlMs, // shorter TTL for OAuth
      };
    }

    // OpenAI / Gemini / OpenRouter: static API key (same pattern as Anthropic)
    if (connection.provider === "openai" || connection.provider === "gemini" || connection.provider === "openrouter" || connection.provider === "notion") {
      request.log.debug({ tokenType: "api-key", provider: connection.provider }, "cred.tokenType");

      if (!tokenData.apiKey) {
        return reply500(reply, new Error(`${connection.provider} API key not found in connection`), `${connection.provider} API key not found in connection`, { request, extra: { connectionId: connection.id } });
      }

      logEvent({
        actor: sub,
        agentId: agentId ?? null,
        connectionId: connection.id,
        action: "credential_resolved",
        decision: "allowed",
        metadata: { kind: body.kind, provider: body.provider, mode: "api-key" },
      });

      request.log.debug({ provider: connection.provider, mode: "api-key", cacheTtlMs: 300_000 }, "cred.resolved");

      return {
        apiKey: tokenData.apiKey,
        source: `vault:${connection.provider}:${connection.id}`,
        mode: "api-key" as const,
        cacheTtlMs: 300_000,
      };
    }

    // Permanent OAuth tokens (e.g., Notion) — no refresh needed, use directly.
    // Distinguishes from broken state (refreshToken: null) by checking for undefined.
    if (tokenData.accessToken && tokenData.refreshToken === undefined) {
      request.log.debug({ tokenType: "oauth", provider: connection.provider, permanent: true }, "cred.tokenType");

      logEvent({
        actor: sub,
        agentId: agentId ?? null,
        connectionId: connection.id,
        action: "credential_resolved",
        decision: "allowed",
        metadata: { kind: body.kind, provider: body.provider, mode: "oauth-permanent" },
      });

      request.log.debug({ provider: connection.provider, mode: "oauth-permanent", cacheTtlMs: 300_000 }, "cred.resolved");

      return {
        apiKey: tokenData.accessToken,
        source: `vault:${connection.provider}:${connection.id}`,
        mode: "oauth" as const,
        cacheTtlMs: 300_000,
      };
    }

    // OAuth providers: refresh if needed, return access token
    request.log.debug({ tokenType: "oauth", provider: connection.provider, hasRefreshToken: !!tokenData.refreshToken }, "cred.tokenType");

    if (!tokenData.refreshToken) {
      await markConnectionNeedsReauth(connection.id, "No refresh token available", request.log);
      return reply.code(404).send({ error: "Connection requires reauthentication" });
    }

    let accessToken = tokenData.accessToken;
    let expiresInMs = tokenData.expiresAt
      ? new Date(tokenData.expiresAt).getTime() - Date.now()
      : 0;

    // Refresh if expired or expiring within 60 seconds
    if (!accessToken || expiresInMs < 60_000) {
      try {
        request.log.debug({ provider: connection.provider, reason: accessToken ? "expiring_soon" : "no_access_token" }, "cred.refresh");
        const { connector } = await resolveConnector({
          provider: connection.provider,
          oauthAppId: connection.oauthAppId,
          workspaceId: wid,
        });
        const newTokenSet = await connector.refresh(tokenData.refreshToken);
        accessToken = newTokenSet.accessToken;

        expiresInMs = newTokenSet.expiresAt
          ? new Date(newTokenSet.expiresAt).getTime() - Date.now()
          : 3600_000;

        // Re-encrypt and store updated tokens (fire-and-forget)
        const updatedPayload = JSON.stringify({
          accessToken: newTokenSet.accessToken,
          refreshToken: newTokenSet.refreshToken ?? tokenData.refreshToken,
          tokenType: newTokenSet.tokenType,
          expiresAt: newTokenSet.expiresAt,
        });

        const { encrypt } = await import("@agenthifive/security");
        const encrypted = JSON.stringify(encrypt(updatedPayload, getEncryptionKey()));

        db.update(connections)
          .set({ encryptedTokens: encrypted, updatedAt: new Date() })
          .where(eq(connections.id, connection.id))
          .then(() => {})
          .catch((err) => request.log.error(err, "Failed to update tokens after refresh"));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Token refresh failed";
        request.log.warn({ err, connectionId: connection.id }, "Token refresh failed during credential resolve");
        await markConnectionNeedsReauth(connection.id, message, request.log);
        return reply.code(404).send({ error: "Connection requires reauthentication" });
      }
    }

    // Build extra fields for multi-field credentials
    const extra: Record<string, string> = {};
    const metadata = connection.metadata as Record<string, unknown> | null;
    if (metadata) {
      // MS Teams: include tenantId if available
      if (metadata["tenantId"]) extra["tenantId"] = String(metadata["tenantId"]);
      // Slack: include appToken if stored
      if (metadata["appToken"]) extra["appToken"] = String(metadata["appToken"]);
    }

    // MS Teams channel: include Bot Framework credentials so OpenClaw can
    // initialize the webhook server without storing secrets locally.
    // These are the same Azure AD app credentials used for OAuth — the SDK
    // calls them appId/appPassword instead of clientId/clientSecret.
    if (connection.service === "microsoft-teams" && body.kind === "channel") {
      const clientId = process.env["MICROSOFT_CLIENT_ID"];
      const clientSecret = process.env["MICROSOFT_CLIENT_SECRET"];
      const tenantId = process.env["MICROSOFT_TENANT_ID"];
      if (clientId) extra["appId"] = clientId;
      if (clientSecret) extra["appPassword"] = clientSecret;
      if (tenantId && !extra["tenantId"]) extra["tenantId"] = tenantId;
    }

    // Cache TTL: credential is valid until the access token expires, capped at 5 min
    const cacheTtlMs = Math.min(Math.max(expiresInMs - 60_000, 30_000), 300_000);

    logEvent({
      actor: sub,
      agentId: agentId ?? null,
      connectionId: connection.id,
      action: "credential_resolved",
      decision: "allowed",
      metadata: { kind: body.kind, provider: body.provider, mode: "oauth" },
    });

    request.log.debug(
      { provider: connection.provider, mode: "oauth", cacheTtlMs, hasExtra: Object.keys(extra).length > 0 },
      "cred.resolved",
    );

    return {
      apiKey: accessToken,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
      source: `vault:${connection.provider}:${connection.id}`,
      mode: "oauth" as const,
      cacheTtlMs,
    };
  });
}
