import type { FastifyInstance } from "fastify";
import { reply500 } from "../utils/reply-error";
import { request as undiciRequest } from "undici";
import { randomBytes, createHash } from "node:crypto";
import { eq, and, ne } from "drizzle-orm";
import { db } from "../db/client";
import { pendingConnections } from "../db/schema/pending-connections";
import { connections } from "../db/schema/connections";
import { policies } from "../db/schema/policies";
import { agents } from "../db/schema/agents";
import { agentPermissionRequests } from "../db/schema";
import { encrypt, decrypt, type EncryptedPayload } from "@agenthifive/security";
import { resolveConnector } from "../utils/oauth-connector-factory";
import { validateEmailConnection } from "./email-provider";
import { logConnectionNeedsReauth, logConnectionRevoked } from "../services/audit";
import { fetchMicrosoftProfile } from "../utils/microsoft-profile";
import { buildProviderAuthHeaders } from "../utils/provider-auth";
import { SERVICE_CATALOG, SERVICE_IDS, getProviderForService, getDefaultAllowlistsForService, getActionTemplate, getActionTemplatesForService, type ServiceId, type PolicyTier } from "@agenthifive/contracts";
import { generatePolicyFromTemplate } from "../services/policy-generator";

const WEB_URL = process.env["WEB_URL"] || "http://localhost:3000";
import { getEncryptionKey } from "../services/encryption-key";

type InlineCredentialPreview = {
  primaryLabel: string;
  primaryMasked: string;
  secondaryLabel?: string;
  secondaryMasked?: string;
  tertiaryLabel?: string;
  tertiaryValue?: string;
};

function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}...`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function buildInlineCredentialPreview(
  provider: string,
  credentialType: "api_key" | "bot_token" | "email",
  tokenData: Record<string, unknown>,
): InlineCredentialPreview | null {
  if (credentialType === "email") {
    const email = typeof tokenData["email"] === "string" ? tokenData["email"] : null;
    if (!email) return null;
    return {
      primaryLabel: "Email",
      primaryMasked: maskSecret(email),
    };
  }

  if (credentialType === "bot_token") {
    const botToken = typeof tokenData["botToken"] === "string" ? tokenData["botToken"] : null;
    if (!botToken) return null;
    return {
      primaryLabel: provider === "slack" ? "Bot token" : "Stored token",
      primaryMasked: maskSecret(botToken),
    };
  }

  const apiKey = typeof tokenData["apiKey"] === "string" ? tokenData["apiKey"] : null;
  if (!apiKey) return null;

  const preview: InlineCredentialPreview = {
    primaryLabel: provider === "trello" ? "User token" : provider === "jira" ? "API token" : "API key",
    primaryMasked: maskSecret(apiKey),
  };

  const appKey = typeof tokenData["appKey"] === "string" ? tokenData["appKey"] : null;
  if (appKey) {
    preview.secondaryLabel = "App key";
    preview.secondaryMasked = maskSecret(appKey);
  }

  if (provider === "jira") {
    const siteUrl = typeof tokenData["siteUrl"] === "string" ? tokenData["siteUrl"] : null;
    if (siteUrl) {
      preview.tertiaryLabel = "Site URL";
      preview.tertiaryValue = siteUrl;
    }
  }

  return preview;
}

function decryptInlineCredentialPreview(
  provider: string,
  service: string,
  encryptedTokens: string | null,
): InlineCredentialPreview | null {
  if (!encryptedTokens || !getEncryptionKey()) return null;
  const entry = SERVICE_CATALOG[service as ServiceId];
  const inlineTypes = new Set(["api_key", "bot_token", "email"]);
  if (!entry || !inlineTypes.has(entry.credentialType)) return null;

  try {
    const encryptedPayload = JSON.parse(encryptedTokens) as EncryptedPayload;
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    const tokenData = JSON.parse(decrypted) as Record<string, unknown>;
    return buildInlineCredentialPreview(provider, entry.credentialType as "api_key" | "bot_token" | "email", tokenData);
  } catch {
    return null;
  }
}

/**
 * Detect if an error from a provider indicates the token is invalid/expired.
 * Call this from token vending (Model A) or execution (Model B) when a provider
 * returns 401/403 during token refresh.
 */
export async function markConnectionNeedsReauth(
  connectionId: string,
  reason: string,
  _logger?: { error: (...args: unknown[]) => void },
): Promise<void> {
  await db
    .update(connections)
    .set({ status: "needs_reauth", updatedAt: new Date() })
    .where(eq(connections.id, connectionId));

  logConnectionNeedsReauth(connectionId, { reason });
}

/**
 * Check if an HTTP status code from a provider indicates an auth failure.
 */
export function isProviderAuthError(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}

/** 15-minute expiry for pending connections */
const PENDING_EXPIRY_MS = 15 * 60 * 1000;

export default async function connectionRoutes(fastify: FastifyInstance) {
  async function updateInlineCredential(
    connection: {
      id: string;
      provider: string;
      service: string;
      label: string;
    },
    body: { botToken?: string; apiKey?: string; appKey?: string; email?: string; siteUrl?: string } | undefined,
  ) {
    const entry = SERVICE_CATALOG[connection.service as ServiceId];
    if (!entry || (entry.credentialType !== "bot_token" && entry.credentialType !== "api_key")) {
      throw new Error("Inline credential updates are not supported for this connection");
    }

    if (!getEncryptionKey()) {
      throw new Error("Encryption key not configured");
    }

    if (entry.credentialType === "bot_token") {
      if (!body?.botToken || typeof body.botToken !== "string" || body.botToken.trim().length === 0) {
        throw new Error("botToken is required");
      }

      let metadata: Record<string, unknown>;
      if (entry.provider === "telegram") {
        const { TelegramBotProvider } = await import("@agenthifive/oauth-connectors");
        const telegram = new TelegramBotProvider();
        const botInfo = await telegram.validateBotToken(body.botToken);
        metadata = { botId: botInfo.id, botUsername: botInfo.username, botFirstName: botInfo.firstName };
      } else if (entry.provider === "slack") {
        if (!body.botToken.startsWith("xoxb-")) {
          throw new Error("Invalid Slack bot token format. Token must start with xoxb-");
        }
        const authRes = await fetch("https://slack.com/api/auth.test", {
          method: "POST",
          headers: { Authorization: `Bearer ${body.botToken}`, "Content-Type": "application/json" },
        });
        const authData = (await authRes.json()) as {
          ok: boolean; error?: string; bot_id?: string; user_id?: string;
          team_id?: string; team?: string; url?: string;
        };
        if (!authData.ok) {
          throw new Error(`Slack token validation failed: ${authData.error ?? "unknown error"}`);
        }
        metadata = { botId: authData.bot_id, botUserId: authData.user_id, teamId: authData.team_id, teamName: authData.team, teamUrl: authData.url };
      } else {
        throw new Error(`No bot token validation implemented for provider: ${entry.provider}`);
      }

      const tokenPayload = JSON.stringify({ botToken: body.botToken.trim(), tokenType: "bot" });
      const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));
      await db.update(connections).set({
        encryptedTokens,
        status: "healthy",
        metadata,
        updatedAt: new Date(),
      }).where(eq(connections.id, connection.id));

      return {
        connection: { id: connection.id, provider: connection.provider, service: connection.service, label: connection.label, status: "healthy" as const },
        message: `${entry.displayName} credential updated successfully`,
      };
    }

    if (!body?.apiKey || typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
      throw new Error("apiKey is required");
    }

    if (connection.provider === "trello") {
      if (!body.appKey || typeof body.appKey !== "string" || body.appKey.trim().length === 0) {
        throw new Error("appKey (Trello Power-Up API key) is required");
      }
    }

    if (connection.provider === "jira") {
      if (!body.email || typeof body.email !== "string" || body.email.trim().length === 0) {
        throw new Error("email is required");
      }
      if (!body.siteUrl || typeof body.siteUrl !== "string" || body.siteUrl.trim().length === 0) {
        throw new Error("siteUrl is required");
      }
    }

    const tokenData: Record<string, string> = { apiKey: body.apiKey.trim() };
    if (connection.provider === "trello" && body.appKey) {
      tokenData.appKey = body.appKey.trim();
    }
    if (connection.provider === "jira" && body.email && body.siteUrl) {
      tokenData.email = body.email.trim();
      tokenData.siteUrl = body.siteUrl.trim().replace(/^https?:\/\//, "");
    }
    const tokenPayload = JSON.stringify(tokenData);
    const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

    await db.update(connections).set({
      encryptedTokens,
      status: "healthy",
      updatedAt: new Date(),
    }).where(eq(connections.id, connection.id));

    return {
      connection: { id: connection.id, provider: connection.provider, service: connection.service, label: connection.label, status: "healthy" as const },
      message: `${entry.displayName} credential updated successfully`,
    };
  }

  /**
   * GET /connections
   * Returns list of connections for the current workspace.
   * Never exposes encrypted tokens.
   */
  fastify.get("/connections", {
    schema: {
      tags: ["Connections"],
      summary: "List connections",
      description: "Returns active connections for the current workspace (excludes revoked). Never exposes encrypted tokens.",
      response: {
        200: {
          type: "object",
          properties: {
            connections: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  provider: { type: "string", enum: ["google", "microsoft", "telegram"] },
                  service: { type: "string" },
                  label: { type: "string" },
                  status: { type: "string", enum: ["healthy", "needs_reauth", "revoked"] },
                  singleton: { type: "boolean" },
                  grantedScopes: { type: "array", items: { type: "string" } },
                  metadata: { type: "object", additionalProperties: true },
                  credentialPreview: {
                    type: ["object", "null"],
                    properties: {
                      primaryLabel: { type: "string" },
                      primaryMasked: { type: "string" },
                      secondaryLabel: { type: "string" },
                      secondaryMasked: { type: "string" },
                      tertiaryLabel: { type: "string" },
                      tertiaryValue: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                  createdAt: { type: "string", format: "date-time" },
                  updatedAt: { type: "string", format: "date-time" },
                  policies: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        agentId: { type: "string", format: "uuid" },
                        agentName: { type: "string" },
                        actionTemplateId: { type: "string", nullable: true },
                        defaultMode: { type: "string", enum: ["read_only", "read_write", "custom"] },
                        stepUpApproval: { type: "string", enum: ["always", "risk_based", "never"] },
                        allowedModels: { type: "array", items: { type: "string" } },
                        allowlists: { type: "array" },
                        rateLimits: { type: "object", nullable: true },
                        timeWindows: { type: "array" },
                        providerConstraints: { type: "object", nullable: true, additionalProperties: true },
                        securityPreset: { type: "string", nullable: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request) => {
    const { wid } = request.user;

    // Fetch connections with associated policies and agent information
    const rows = await db
      .select({
        id: connections.id,
        provider: connections.provider,
        service: connections.service,
        label: connections.label,
        status: connections.status,
        grantedScopes: connections.grantedScopes,
        metadata: connections.metadata,
        createdAt: connections.createdAt,
        updatedAt: connections.updatedAt,
        encryptedTokens: connections.encryptedTokens,
        // Policy information
        policyId: policies.id,
        agentId: agents.id,
        agentName: agents.name,
        actionTemplateId: policies.actionTemplateId,
        defaultMode: policies.defaultMode,
        stepUpApproval: policies.stepUpApproval,
        allowedModels: policies.allowedModels,
        allowlists: policies.allowlists,
        rateLimits: policies.rateLimits,
        timeWindows: policies.timeWindows,
        providerConstraints: policies.providerConstraints,
        securityPreset: policies.securityPreset,
      })
      .from(connections)
      .leftJoin(policies, eq(policies.connectionId, connections.id))
      .leftJoin(agents, eq(agents.id, policies.agentId))
      .where(and(eq(connections.workspaceId, wid), ne(connections.status, "revoked")))
      .orderBy(connections.createdAt);

    // Group policies by connection
    const connectionsMap = new Map();
    for (const row of rows) {
      if (!connectionsMap.has(row.id)) {
        connectionsMap.set(row.id, {
          id: row.id,
          provider: row.provider,
          service: row.service,
          label: row.label,
          status: row.status,
          singleton: SERVICE_CATALOG[row.service as ServiceId]?.singleton ?? false,
          grantedScopes: row.grantedScopes,
          metadata: row.metadata,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          credentialPreview: decryptInlineCredentialPreview(row.provider, row.service, row.encryptedTokens),
          policies: [],
        });
      }

      // Add policy if it exists
      if (row.policyId && row.agentId && row.agentName) {
        connectionsMap.get(row.id).policies.push({
          id: row.policyId,
          agentId: row.agentId,
          agentName: row.agentName,
          actionTemplateId: row.actionTemplateId,
          defaultMode: row.defaultMode,
          stepUpApproval: row.stepUpApproval,
          allowedModels: row.allowedModels,
          allowlists: row.allowlists,
          rateLimits: row.rateLimits,
          timeWindows: row.timeWindows,
          providerConstraints: row.providerConstraints,
          securityPreset: row.securityPreset,
        });
      }
    }

    return { connections: Array.from(connectionsMap.values()) };
  });

  /**
   * POST /connections/start
   * Starts an OAuth authorization code flow.
   * Returns authorization URL for browser redirect.
   */
  fastify.post("/connections/start", {
    schema: {
      tags: ["Connections"],
      summary: "Start OAuth connection flow",
      description: "Initiates an OAuth authorization code flow with PKCE. Accepts a service ID (e.g. google-gmail) and optional scope overrides.",
      body: {
        type: "object",
        required: ["service"],
        properties: {
          service: { type: "string", description: "Service ID from the service catalog" },
          scopes: { type: "array", items: { type: "string" }, description: "OAuth scopes to request (empty for providers like Notion that configure scopes at integration level)" },
          label: { type: "string", description: "Display label for the connection" },
          agentId: { type: "string", description: "Optional agent ID to auto-create and bind policy after connection" },
          allowedModels: { type: "array", items: { type: "string", enum: ["A", "B"] }, description: "Execution models to allow (defaults to ['B'])" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            pendingConnectionId: { type: "string", format: "uuid" },
            authorizationUrl: { type: "string", format: "uri" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      service?: string;
      scopes?: string[];
      label?: string;
      agentId?: string;
      allowedModels?: string[];
    };

    const serviceId = body.service as ServiceId;

    // Validate service ID
    if (!serviceId || !SERVICE_IDS.includes(serviceId)) {
      return reply
        .code(400)
        .send({ error: `Invalid service. Must be one of: ${SERVICE_IDS.join(", ")}` });
    }

    // Bot token services handled separately (not OAuth)
    const catalogEntry = SERVICE_CATALOG[serviceId];
    if (catalogEntry.credentialType === "bot_token") {
      return reply
        .code(400)
        .send({ error: `${catalogEntry.displayName} uses bot tokens, not OAuth. Use POST /connections/bot-token instead.` });
    }

    const rawScopes: string[] = body.scopes ?? catalogEntry.scopes?.map((s) => s.value) ?? [];
    if (!Array.isArray(rawScopes)) {
      return reply
        .code(400)
        .send({ error: "scopes must be an array" });
    }
    if (rawScopes.length === 0) {
      return reply
        .code(400)
        .send({ error: "scopes must not be empty for OAuth connections" });
    }
    const provider = getProviderForService(serviceId);
    // Microsoft requires offline_access to return refresh tokens, but it's often
    // missing from grantedScopes (it's a meta-scope, not an API permission).
    // Google uses URL-style scopes and doesn't need this — it returns refresh tokens
    // when prompt=consent and access_type=offline are set.
    const scopes = provider === "microsoft" && !rawScopes.includes("offline_access")
      ? [...rawScopes, "offline_access"]
      : rawScopes;
    const label = body.label ?? `${catalogEntry.displayName} connection`;

    const { connector, oauthAppId } = await resolveConnector({ provider, workspaceId: wid });
    const expiresAt = new Date(Date.now() + PENDING_EXPIRY_MS);

    request.log.info(
      { service: serviceId, provider, scopeCount: scopes.length, agentId: body.agentId },
      "conn.oauth.start",
    );

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const redirectUri = `${WEB_URL}/api/connections/callback`;

    const { authorizationUrl } = await connector.createAuthorizationUrl({
      redirectUri,
      scopes,
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
    });

    const [pending] = await db
      .insert(pendingConnections)
      .values({
        provider: provider as "google" | "microsoft",
        service: serviceId,
        workspaceId: wid,
        state,
        codeVerifier,
        scopes,
        label,
        metadata: {
          redirectUri,
          agentId: body.agentId,
          allowedModels: body.allowedModels || ["B"], // Default to Model B if not specified
          ...(oauthAppId && { byaOauthAppId: oauthAppId }),
        },
        expiresAt,
      })
      .returning({ id: pendingConnections.id });

    return {
      pendingConnectionId: pending!.id,
      authorizationUrl,
    };
  });

  /**
   * POST /connections/bot-token
   * Generic endpoint for all bot_token services (Telegram, Slack, etc.).
   * Validates the token via the provider's API and stores it encrypted.
   */
  fastify.post("/connections/bot-token", {
    schema: {
      tags: ["Connections"],
      summary: "Connect a bot token service",
      description: "Validates a bot token for any bot_token service (Telegram, Slack) and stores it encrypted.",
      body: {
        type: "object",
        required: ["service", "botToken"],
        properties: {
          service: { type: "string", description: "Service ID (e.g., 'telegram', 'slack')" },
          botToken: { type: "string", description: "Bot token or Bot User OAuth Token" },
          label: { type: "string", description: "Display label for the connection" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            connection: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                provider: { type: "string" },
                service: { type: "string" },
                label: { type: "string" },
                status: { type: "string" },
                metadata: { type: "object", additionalProperties: true },
              },
            },
            botInfo: { type: "object", additionalProperties: true },
            label: { type: "string" },
            message: { type: "string" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      service?: string;
      botToken?: string;
      label?: string;
    };

    if (!body.service || !SERVICE_IDS.includes(body.service as ServiceId)) {
      return reply.code(400).send({ error: `Invalid service: ${body.service}` });
    }

    const serviceId = body.service as ServiceId;
    const entry = SERVICE_CATALOG[serviceId];

    if (entry.credentialType !== "bot_token") {
      return reply.code(400).send({ error: `Service '${serviceId}' does not use bot tokens` });
    }

    if (!body.botToken || typeof body.botToken !== "string") {
      return reply.code(400).send({ error: "botToken is required" });
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    // Validate + build metadata per provider
    let label: string;
    let metadata: Record<string, unknown>;
    let grantedScopes: string[];

    if (entry.provider === "telegram") {
      const { TelegramBotProvider } = await import("@agenthifive/oauth-connectors");
      const telegram = new TelegramBotProvider();
      const botInfo = await telegram.validateBotToken(body.botToken);
      label = body.label ?? `Telegram @${botInfo.username}`;
      metadata = { botId: botInfo.id, botUsername: botInfo.username, botFirstName: botInfo.firstName };
      grantedScopes = ["bot:sendMessage", "bot:getUpdates"];
    } else if (entry.provider === "slack") {
      if (!body.botToken.startsWith("xoxb-")) {
        return reply.code(400).send({ error: "Invalid Slack bot token format. Token must start with xoxb-" });
      }
      const authRes = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { "Authorization": `Bearer ${body.botToken}`, "Content-Type": "application/json" },
      });
      const authData = (await authRes.json()) as {
        ok: boolean; error?: string; bot_id?: string; user_id?: string;
        team_id?: string; team?: string; url?: string;
      };
      if (!authData.ok) {
        return reply.code(400).send({ error: `Slack token validation failed: ${authData.error ?? "unknown error"}` });
      }
      label = body.label ?? `Slack ${authData.team ?? "Bot"}`;
      metadata = { botId: authData.bot_id, botUserId: authData.user_id, teamId: authData.team_id, teamName: authData.team, teamUrl: authData.url };
      grantedScopes = ["chat:write", "channels:history", "channels:read", "users:read", "reactions:write", "files:write"];
    } else {
      return reply.code(400).send({ error: `No bot token validation implemented for provider: ${entry.provider}` });
    }

    // Encrypt and store
    const tokenPayload = JSON.stringify({ botToken: body.botToken, tokenType: "bot" });
    const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

    const [connection] = await db
      .insert(connections)
      .values({
        provider: entry.provider as "telegram" | "slack",
        service: serviceId,
        label,
        status: "healthy",
        workspaceId: wid,
        encryptedTokens,
        grantedScopes,
        metadata,
      })
      .returning({
        id: connections.id,
        provider: connections.provider,
        service: connections.service,
        label: connections.label,
        status: connections.status,
        metadata: connections.metadata,
      });

    request.log.info(
      { connectionId: connection!.id, provider: entry.provider, service: body.service, isReauth: false },
      "conn.created",
    );

    return {
      connection: connection!,
      botInfo: metadata,
      label,
      message: `${entry.displayName} connected successfully`,
    };
  });

  /**
   * POST /connections/api-key
   * Creates a connection for an API key provider (e.g., Anthropic).
   * Validates the key format and stores it encrypted.
   */
  fastify.post("/connections/api-key", {
    schema: {
      tags: ["Connections"],
      summary: "Connect API key provider",
      description:
        "Stores an API key for a provider that uses static API keys (e.g., Anthropic). " +
        "The key is encrypted at rest and never returned after creation.",
      body: {
        type: "object",
        required: ["provider", "service", "apiKey"],
        properties: {
          provider: {
            type: "string",
            enum: ["anthropic", "openai", "gemini", "openrouter", "notion", "trello", "jira"],
            description: "Provider name",
          },
          service: {
            type: "string",
            enum: ["anthropic-messages", "openai", "gemini", "openrouter", "notion", "trello", "jira"],
            description: "Service ID",
          },
          apiKey: {
            type: "string",
            description: "Provider API key (or user token for Trello)",
          },
          appKey: {
            type: "string",
            description: "App-level API key (Trello Power-Up API key). Required for Trello.",
          },
          email: {
            type: "string",
            description: "Email address (required for Jira)",
          },
          siteUrl: {
            type: "string",
            description: "Jira Cloud site URL, e.g. mycompany.atlassian.net (required for Jira)",
          },
          label: {
            type: "string",
            description: "Display label for the connection",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            connection: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                provider: { type: "string" },
                service: { type: "string" },
                label: { type: "string" },
                status: { type: "string", enum: ["healthy"] },
              },
            },
            message: { type: "string" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      provider: string;
      service: string;
      apiKey: string;
      appKey?: string;
      email?: string;
      siteUrl?: string;
      label?: string;
    };

    if (!body.apiKey || typeof body.apiKey !== "string" || body.apiKey.trim().length === 0) {
      return reply.code(400).send({ error: "apiKey is required" });
    }

    // Jira requires email + siteUrl alongside the API token
    if (body.provider === "jira") {
      if (!body.email || typeof body.email !== "string" || body.email.trim().length === 0) {
        return reply.code(400).send({ error: "email is required for Jira connections" });
      }
      if (!body.siteUrl || typeof body.siteUrl !== "string" || body.siteUrl.trim().length === 0) {
        return reply.code(400).send({ error: "siteUrl is required for Jira connections" });
      }
    }

    // Trello requires both an app-level API key (Power-Up) and a user token
    if (body.provider === "trello") {
      if (!body.appKey || typeof body.appKey !== "string" || body.appKey.trim().length === 0) {
        return reply.code(400).send({ error: "appKey (Trello Power-Up API key) is required for Trello connections" });
      }
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    // Validate the API key by calling a lightweight provider endpoint
    const apiKey = body.apiKey.trim();
    let metadata: Record<string, unknown> | undefined;

    try {
      if (body.provider === "anthropic") {
        const authHeaders = { ...buildProviderAuthHeaders("anthropic", apiKey), "content-type": "application/json" };
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
        });
        if (res.status === 401 || res.status === 403) {
          const errorBody = await res.text().catch(() => "");
          request.log.warn({ status: res.status, errorBody: errorBody.slice(0, 500), keyPrefix: apiKey.slice(0, 10) }, "Anthropic API key validation failed");
          request.log.debug({ provider: "anthropic", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "Anthropic credential is invalid. Check your key at console.anthropic.com." });
        }
        request.log.debug({ provider: "anthropic", valid: true, statusCode: res.status }, "conn.apikey.validated");
      } else if (body.provider === "openai") {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: buildProviderAuthHeaders("openai", apiKey),
        });
        if (!res.ok) {
          request.log.debug({ provider: "openai", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "OpenAI API key is invalid. Check your key at platform.openai.com." });
        }
        request.log.debug({ provider: "openai", valid: true, statusCode: res.status }, "conn.apikey.validated");
      } else if (body.provider === "gemini") {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
        if (!res.ok) {
          request.log.debug({ provider: "gemini", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "Gemini API key is invalid. Check your key at aistudio.google.com/apikey." });
        }
        request.log.debug({ provider: "gemini", valid: true, statusCode: res.status }, "conn.apikey.validated");
      } else if (body.provider === "openrouter") {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: buildProviderAuthHeaders("openrouter", apiKey),
        });
        if (!res.ok) {
          request.log.debug({ provider: "openrouter", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "OpenRouter API key is invalid. Check your key at openrouter.ai/settings/keys." });
        }
        request.log.debug({ provider: "openrouter", valid: true, statusCode: res.status }, "conn.apikey.validated");
      } else if (body.provider === "notion") {
        const res = await fetch("https://api.notion.com/v1/users/me", {
          headers: buildProviderAuthHeaders("notion", apiKey),
        });
        if (!res.ok) {
          request.log.debug({ provider: "notion", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "Notion integration token is invalid. Check your token at notion.so/profile/integrations." });
        }
        request.log.debug({ provider: "notion", valid: true, statusCode: res.status }, "conn.apikey.validated");
        const userData = (await res.json()) as { name?: string; bot?: { owner?: { user?: { id?: string } } } };
        metadata = { botName: userData.name, botOwnerId: userData.bot?.owner?.user?.id };
      } else if (body.provider === "trello") {
        const trelloAppKey = body.appKey!.trim();
        const res = await fetch(`https://api.trello.com/1/members/me?key=${encodeURIComponent(trelloAppKey)}&token=${encodeURIComponent(apiKey)}`);
        if (!res.ok) {
          request.log.debug({ provider: "trello", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: "Trello credentials are invalid. Check your Power-Up API key and user token." });
        }
        request.log.debug({ provider: "trello", valid: true, statusCode: res.status }, "conn.apikey.validated");
        const memberData = (await res.json()) as { fullName?: string; username?: string };
        metadata = { fullName: memberData.fullName, username: memberData.username };
      } else if (body.provider === "jira") {
        const email = body.email!.trim();
        const siteUrl = body.siteUrl!.trim().replace(/^https?:\/\//, "");
        if (!siteUrl.endsWith(".atlassian.net")) {
          return reply.code(400).send({ error: "Jira site URL must end with .atlassian.net (Jira Cloud only)" });
        }
        const basicAuth = Buffer.from(`${email}:${apiKey}`).toString("base64");
        const res = await fetch(`https://${siteUrl}/rest/api/3/myself`, {
          headers: { Authorization: `Basic ${basicAuth}`, Accept: "application/json" },
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          request.log.warn({ jiraStatus: res.status, jiraBody: errBody.slice(0, 500), siteUrl }, "Jira credential validation failed");
          request.log.debug({ provider: "jira", valid: false, statusCode: res.status }, "conn.apikey.validated");
          return reply.code(400).send({ error: `Jira credentials are invalid (HTTP ${res.status}). Check your site URL, email, and API token.` });
        }
        request.log.debug({ provider: "jira", valid: true, statusCode: res.status }, "conn.apikey.validated");
        const userData = (await res.json()) as { displayName?: string };
        metadata = { displayName: userData.displayName, siteUrl, email };
      }
    } catch {
      return reply.code(400).send({ error: `Could not reach ${body.provider} API to validate the key. Please try again.` });
    }

    const label = body.label ?? `${body.provider} connection`;

    // Encrypt the API key (and appKey for Trello) before storage
    const tokenData: Record<string, string> = { apiKey };
    if (body.provider === "trello" && body.appKey) {
      tokenData.appKey = body.appKey.trim();
    }
    if (body.provider === "jira" && body.email && body.siteUrl) {
      tokenData.email = body.email.trim();
      tokenData.siteUrl = body.siteUrl.trim().replace(/^https?:\/\//, "");
    }
    const tokenPayload = JSON.stringify(tokenData);
    const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

    // Set scopes based on provider capability
    const grantedScopes = body.provider === "anthropic"
      ? ["messages"]
      : body.provider === "notion"
        ? ["read", "write"]
        : body.provider === "trello"
          ? ["read", "write"]
          : body.provider === "jira"
            ? ["read", "write"]
            : ["chat", "embeddings"]; // openai, gemini, openrouter

    const [connection] = await db
      .insert(connections)
      .values({
        provider: body.provider as "anthropic" | "openai" | "gemini" | "openrouter" | "notion" | "trello" | "jira",
        service: body.service as "anthropic-messages" | "openai" | "gemini" | "openrouter" | "notion" | "trello" | "jira",
        label,
        status: "healthy",
        workspaceId: wid,
        encryptedTokens,
        grantedScopes,
        ...(metadata && { metadata }),
      })
      .returning({
        id: connections.id,
        provider: connections.provider,
        service: connections.service,
        label: connections.label,
        status: connections.status,
      });

    request.log.info(
      { connectionId: connection!.id, provider: body.provider, service: body.service, isReauth: false },
      "conn.created",
    );

    return {
      connection: connection!,
      message: `${body.provider} connection created successfully`,
    };
  });

  /**
   * POST /connections/email
   * Creates a connection for an email (IMAP/SMTP) provider.
   * Validates IMAP/SMTP connectivity and stores credentials encrypted.
   */
  fastify.post("/connections/email", {
    schema: {
      tags: ["Connections"],
      summary: "Connect email (IMAP/SMTP)",
      description:
        "Stores IMAP and SMTP credentials for a generic email account. " +
        "Credentials are validated by connecting to both servers, then encrypted at rest.",
      body: {
        type: "object",
        required: ["email", "imapHost", "smtpHost", "password"],
        properties: {
          email: { type: "string", description: "Email address" },
          displayName: { type: "string", description: "Sender display name" },
          imapHost: { type: "string", description: "IMAP server hostname" },
          imapPort: { type: "number", description: "IMAP server port (default 993)" },
          imapTls: { type: "boolean", description: "Use TLS for IMAP (default true)" },
          smtpHost: { type: "string", description: "SMTP server hostname" },
          smtpPort: { type: "number", description: "SMTP server port (default 587)" },
          smtpStarttls: { type: "boolean", description: "Use STARTTLS for SMTP (default true)" },
          username: { type: "string", description: "Login username (defaults to email)" },
          password: { type: "string", description: "Email password or app password" },
          label: { type: "string", description: "Display label for the connection" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            connection: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                provider: { type: "string" },
                service: { type: "string" },
                label: { type: "string" },
                status: { type: "string", enum: ["healthy"] },
              },
            },
            message: { type: "string" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      email: string;
      displayName?: string;
      imapHost: string;
      imapPort?: number;
      imapTls?: boolean;
      smtpHost: string;
      smtpPort?: number;
      smtpStarttls?: boolean;
      username?: string;
      password: string;
      label?: string;
    };

    if (!body.email || typeof body.email !== "string" || body.email.trim().length === 0) {
      return reply.code(400).send({ error: "email is required" });
    }
    if (!body.imapHost || typeof body.imapHost !== "string" || body.imapHost.trim().length === 0) {
      return reply.code(400).send({ error: "imapHost is required" });
    }
    if (!body.smtpHost || typeof body.smtpHost !== "string" || body.smtpHost.trim().length === 0) {
      return reply.code(400).send({ error: "smtpHost is required" });
    }
    if (!body.password || typeof body.password !== "string" || body.password.trim().length === 0) {
      return reply.code(400).send({ error: "password is required" });
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    const email = body.email.trim();
    const username = body.username?.trim() || email;
    const password = body.password.trim();
    const imapHost = body.imapHost.trim();
    const imapPort = body.imapPort ?? 993;
    const imapTls = body.imapTls ?? true;
    const smtpHost = body.smtpHost.trim();
    const smtpPort = body.smtpPort ?? 587;
    const smtpStarttls = body.smtpStarttls ?? true;

    const emailCredentials = {
      email,
      ...(body.displayName && { displayName: body.displayName.trim() }),
      imap: { host: imapHost, port: imapPort, tls: imapTls, username, password },
      smtp: { host: smtpHost, port: smtpPort, starttls: smtpStarttls, username, password },
    };

    // Validate connection by testing IMAP and SMTP
    try {
      const result = await validateEmailConnection(emailCredentials);
      if (!result.valid) {
        request.log.debug({ provider: "email", valid: false, error: result.error }, "conn.email.validated");
        return reply.code(400).send({ error: result.error || "Email connection validation failed" });
      }
      request.log.debug({ provider: "email", valid: true }, "conn.email.validated");
    } catch {
      return reply.code(400).send({ error: "Could not validate email connection. Please check your credentials and server settings." });
    }

    const label = body.label ?? `${email} (IMAP/SMTP)`;

    // Encrypt credentials before storage
    const tokenData: Record<string, unknown> = {
      email,
      ...(body.displayName && { displayName: body.displayName.trim() }),
      imap: { host: imapHost, port: imapPort, tls: imapTls, username, password },
      smtp: { host: smtpHost, port: smtpPort, starttls: smtpStarttls, username, password },
    };
    const tokenPayload = JSON.stringify(tokenData);
    const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

    const grantedScopes = ["imap", "smtp", "write"];

    const [connection] = await db
      .insert(connections)
      .values({
        provider: "email",
        service: "email-imap",
        label,
        status: "healthy",
        workspaceId: wid,
        encryptedTokens,
        grantedScopes,
      })
      .returning({
        id: connections.id,
        provider: connections.provider,
        service: connections.service,
        label: connections.label,
        status: connections.status,
      });

    request.log.info(
      { connectionId: connection!.id, provider: "email", service: "email-imap", isReauth: false },
      "conn.created",
    );

    return {
      connection: connection!,
      message: "Email connection created successfully",
    };
  });

  /**
   * POST /connections/anthropic-oauth
   * Creates an Anthropic connection using OAuth tokens (access + refresh).
   * The tokens are encrypted and the access token is auto-refreshed on use.
   */
  fastify.post("/connections/anthropic-oauth", {
    schema: {
      tags: ["Connections"],
      summary: "Connect Anthropic via OAuth tokens",
      description:
        "Stores Anthropic OAuth tokens (from OpenClaw/pi-ai auth-profiles.json). " +
        "The access token is auto-refreshed when it expires.",
      body: {
        type: "object",
        required: ["accessToken", "refreshToken"],
        properties: {
          accessToken: { type: "string", description: "Anthropic OAuth access token" },
          refreshToken: { type: "string", description: "Anthropic OAuth refresh token" },
          expiresAt: { type: "number", description: "Access token expiry (ms epoch). Defaults to 0 (expired — forces immediate refresh)." },
          label: { type: "string", description: "Display label for the connection" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            connection: {
              type: "object",
              properties: {
                id: { type: "string", format: "uuid" },
                provider: { type: "string" },
                service: { type: "string" },
                label: { type: "string" },
                status: { type: "string", enum: ["healthy"] },
              },
            },
            message: { type: "string" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  }, async (request, reply) => {
    const { wid } = request.user;
    const body = request.body as {
      accessToken: string;
      refreshToken: string;
      expiresAt?: number;
      label?: string;
    };

    if (!body.refreshToken?.trim()) {
      return reply.code(400).send({ error: "refreshToken is required" });
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    const label = body.label ?? "Anthropic (OAuth)";

    // Store OAuth tokens (same shape as Google/Microsoft OAuth connections)
    const tokenPayload = JSON.stringify({
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      expiresAt: body.expiresAt ?? 0, // 0 = expired, forces refresh on first use
    });
    const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

    const [connection] = await db
      .insert(connections)
      .values({
        provider: "anthropic" as const,
        service: "anthropic-messages" as const,
        label,
        status: "healthy",
        workspaceId: wid,
        encryptedTokens,
        grantedScopes: ["org:create_api_key", "user:profile", "user:inference"],
      })
      .returning({
        id: connections.id,
        provider: connections.provider,
        service: connections.service,
        label: connections.label,
        status: connections.status,
      });

    request.log.info(
      { connectionId: connection!.id, provider: "anthropic", service: "anthropic-messages", isReauth: false },
      "conn.created",
    );

    return {
      connection: connection!,
      message: "Anthropic OAuth connection created successfully",
    };
  });

  /**
   * GET /connections/callback
   * Handles OAuth authorization code callback.
   * Validates CSRF state, exchanges code for tokens, encrypts and stores them.
   */
  fastify.get(
    "/connections/callback",
    {
      config: { skipAuth: true },
      schema: {
        tags: ["Connections"],
        summary: "OAuth callback",
        description: "Handles OAuth authorization code callback. Validates CSRF state, exchanges code for tokens, encrypts and stores them. Redirects to dashboard.",
        security: [],
        querystring: {
          type: "object",
          properties: {
            code: { type: "string" },
            state: { type: "string" },
            iss: { type: "string" },
            error: { type: "string" },
            error_description: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const query = request.query as {
        code?: string;
        state?: string;
        iss?: string;
        error?: string;
        error_description?: string;
      };

      request.log.info(
        { hasCode: !!query.code, hasError: !!query.error },
        "conn.oauth.callback",
      );

      // Handle OAuth error response
      if (query.error) {
        request.log.warn(
          { error: query.error, errorDescription: query.error_description },
          "conn.oauth.callback.error",
        );
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent(query.error_description || query.error)}`,
        );
      }

      if (!query.code || !query.state) {
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent("Missing code or state parameter")}`,
        );
      }

      if (!getEncryptionKey()) {
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent("Server encryption not configured")}`,
        );
      }

      // Look up the pending connection by state (CSRF validation)
      const [pending] = await db
        .select()
        .from(pendingConnections)
        .where(eq(pendingConnections.state, query.state))
        .limit(1);

      if (!pending) {
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent("Invalid or expired state parameter")}`,
        );
      }

      // Check expiry
      if (pending.expiresAt < new Date()) {
        await db
          .delete(pendingConnections)
          .where(eq(pendingConnections.id, pending.id));
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent("Connection request expired")}`,
        );
      }

      // Exchange authorization code for tokens
      const pendingMeta = pending.metadata as {
        redirectUri?: string;
        reauthConnectionId?: string;
        agentId?: string;
        allowedModels?: string[];
        policyTier?: PolicyTier;
        actionTemplateId?: string;
        permissionRequestId?: string;
        byaOauthAppId?: string;
      } | null;
      const { connector, oauthAppId: resolvedOauthAppId } = await resolveConnector({
        provider: pending.provider,
        oauthAppId: pendingMeta?.byaOauthAppId,
        workspaceId: pending.workspaceId,
      });
      const redirectUri = pendingMeta?.redirectUri ?? `${WEB_URL}/api/connections/callback`;

      let tokenSet;
      try {
        tokenSet = await connector.exchangeAuthorizationCode({
          code: query.code,
          state: query.state,
          ...(query.iss ? { iss: query.iss } : {}),
          codeVerifier: pending.codeVerifier!,
          redirectUri,
        });
      } catch (err) {
        await db
          .delete(pendingConnections)
          .where(eq(pendingConnections.id, pending.id));
        const message =
          err instanceof Error ? err.message : "Token exchange failed";
        return reply.redirect(
          `${WEB_URL}/dashboard/connections?error=${encodeURIComponent(message)}`,
        );
      }

      request.log.info(
        { provider: pending.provider, hasRefreshToken: !!tokenSet.refreshToken, requestedScopes: pending.scopes, grantedScopes: tokenSet.scope },
        "conn.oauth.exchanged",
      );

      // Encrypt tokens before storage — never store refresh_token in plaintext
      const tokenPayload = JSON.stringify({
        accessToken: tokenSet.accessToken,
        refreshToken: tokenSet.refreshToken,
        tokenType: tokenSet.tokenType,
        expiresAt: tokenSet.expiresAt,
      });
      const encryptedTokens = JSON.stringify(encrypt(tokenPayload, getEncryptionKey()));

      // Determine granted scopes.
      // Microsoft returns ALL previously consented permissions across all apps,
      // not just the ones requested. Intersect with requested scopes so a
      // read-only connection (Mail.Read) doesn't get tagged with Mail.ReadWrite
      // just because the user consented to that scope in another context.
      // Meta-scopes (profile, openid, email, offline_access) are always kept.
      const META_SCOPES = new Set(["profile", "openid", "email", "offline_access"]);
      const requestedSet = new Set(pending.scopes);
      const providerScopes = tokenSet.scope ?? pending.scopes;
      const grantedScopes = pending.provider === "microsoft"
        ? providerScopes.filter(s => requestedSet.has(s) || META_SCOPES.has(s))
        : providerScopes;

      // Fetch provider-specific metadata (e.g., Microsoft account email + tenant info)
      let connectionMetadata: Record<string, unknown> | undefined;
      if (pending.provider === "microsoft" && tokenSet.accessToken) {
        const profile = await fetchMicrosoftProfile(tokenSet.accessToken);
        if (profile) {
          connectionMetadata = {
            email: profile.email,
            displayName: profile.displayName,
          };
          if (profile.tenantId !== undefined) {
            connectionMetadata["tenantId"] = profile.tenantId;
          }
        }
      }
      const reauthConnectionId = pendingMeta?.reauthConnectionId;
      let finalConnectionId: string | undefined;
      let createdPolicyId: string | undefined;

      if (reauthConnectionId) {
        // Reauth flow — update existing connection, preserve metadata and policies
        const updateSet: Record<string, unknown> = {
          encryptedTokens,
          grantedScopes,
          status: "healthy",
          updatedAt: new Date(),
        };
        if (connectionMetadata) {
          updateSet["metadata"] = connectionMetadata;
        }
        await db
          .update(connections)
          .set(updateSet)
          .where(eq(connections.id, reauthConnectionId));

        request.log.info(
          { connectionId: reauthConnectionId, provider: pending.provider, service: pending.service, isReauth: true },
          "conn.reauthed",
        );

        finalConnectionId = reauthConnectionId;
      } else {
        // New connection
        const insertValues: Record<string, unknown> = {
          provider: pending.provider,
          service: pending.service,
          label: pending.label,
          status: "healthy",
          workspaceId: pending.workspaceId,
          encryptedTokens,
          grantedScopes,
          ...(resolvedOauthAppId && { oauthAppId: resolvedOauthAppId }),
        };
        if (connectionMetadata) {
          insertValues["metadata"] = connectionMetadata;
        }
        const [newConnection] = await db
          .insert(connections)
          .values(insertValues as typeof connections.$inferInsert)
          .returning({ id: connections.id });

        finalConnectionId = newConnection?.id;

        request.log.info(
          { connectionId: newConnection?.id, provider: pending.provider, service: pending.service, isReauth: false },
          "conn.created",
        );

        // Auto-create policy if agentId AND policyTier were provided.
        // When policyTier is absent, the frontend handles policy creation via PolicyWizard.
        const agentIdentifier = pendingMeta?.agentId;
        const allowedModels = (pendingMeta?.allowedModels as string[]) || ["B"]; // Default to Model B
        const policyTier = pendingMeta?.policyTier as PolicyTier | undefined;
        const actionTemplateId = pendingMeta?.actionTemplateId as string | undefined;
        const permissionRequestId = pendingMeta?.permissionRequestId as string | undefined;

        if (agentIdentifier && policyTier && newConnection) {
          // Look up the agent by ID (not name!)
          const agent = await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.id, agentIdentifier), eq(agents.workspaceId, pending.workspaceId)))
            .limit(1)
            .then(rows => rows[0]);

          // Only create policy if agent exists
          if (agent) {
            request.log.debug(
              { agentId: agent.id, connectionId: newConnection.id, actionTemplateId, permissionRequestId },
              "conn.oauth.policy.check",
            );

            // Check if a policy already exists for this agent + actionTemplateId
            // This prevents creating duplicates if multiple connections are created
            const existingPolicy = actionTemplateId
              ? await db
                  .select({ id: policies.id, connectionId: policies.connectionId })
                  .from(policies)
                  .where(
                    and(
                      eq(policies.agentId, agent.id),
                      eq(policies.actionTemplateId, actionTemplateId),
                    ),
                  )
                  .limit(1)
                  .then(rows => rows[0])
              : null;

            if (existingPolicy) {
              request.log.debug(
                { agentId: agent.id, existingConnectionId: existingPolicy.connectionId, newConnectionId: newConnection.id, actionTemplateId },
                "conn.oauth.policy.exists",
              );
              createdPolicyId = existingPolicy.id;
            } else if (actionTemplateId) {
              request.log.debug(
                { agentId: agent.id, connectionId: newConnection.id, actionTemplateId, policyTier },
                "conn.oauth.policy.creating",
              );
              // Generate policy from template if we have an action template ID
              try {
                const policyConfig = generatePolicyFromTemplate(actionTemplateId, policyTier);

                const [newPolicy] = await db.insert(policies).values({
                  agentId: agent.id,
                  connectionId: newConnection.id,
                  actionTemplateId,
                  allowedModels,
                  defaultMode: "read_only",
                  stepUpApproval: policyConfig.stepUpApproval,
                  allowlists: policyConfig.allowlists,
                  rateLimits: policyConfig.rateLimits,
                  timeWindows: policyConfig.timeWindows,
                  rules: policyConfig.rules,
                }).returning({ id: policies.id });

                if (newPolicy) {
                  createdPolicyId = newPolicy.id;
                }
              } catch (err) {
                request.log.error({ err, actionTemplateId, policyTier }, "conn.oauth.policy.template_failed");
                // Fallback to basic policy — still usable, user can reconfigure from dashboard
                const [newPolicy] = await db.insert(policies).values({
                  agentId: agent.id,
                  connectionId: newConnection.id,
                  actionTemplateId, // Still save actionTemplateId even if template generation failed
                  allowedModels,
                  defaultMode: "read_only",
                  stepUpApproval: "risk_based",
                  allowlists: getDefaultAllowlistsForService(pending.service),
                  timeWindows: [],
                  rules: { request: [], response: [] },
                }).returning({ id: policies.id });

                if (newPolicy) {
                  createdPolicyId = newPolicy.id;
                }
              }

              // Mark the permission request as approved with a reference to the created connection
              if (permissionRequestId) {
                try {
                  await db
                    .update(agentPermissionRequests)
                    .set({
                      status: "approved",
                      connectionId: newConnection.id,
                      resolvedAt: new Date(),
                    })
                    .where(eq(agentPermissionRequests.id, permissionRequestId));
                  request.log.debug({ permissionRequestId, connectionId: newConnection.id }, "conn.oauth.permission.approved");
                } catch (updateErr) {
                  // Log but don't fail - policy is already created
                  request.log.error({ updateErr, permissionRequestId }, "Failed to update permission request status");
                }
              }
            } else {
              // Legacy flow without action template (direct connection creation)
              const [newPolicy] = await db.insert(policies).values({
                agentId: agent.id,
                connectionId: newConnection.id,
                allowedModels,
                defaultMode: "read_only",
                stepUpApproval: "risk_based",
                allowlists: getDefaultAllowlistsForService(pending.service),
                timeWindows: [],
              }).returning({ id: policies.id });

              if (newPolicy) {
                createdPolicyId = newPolicy.id;
              }
            }
          }
        }
      }

      // Clean up the pending connection
      await db
        .delete(pendingConnections)
        .where(eq(pendingConnections.id, pending.id));

      // Build redirect URL with connection and policy IDs
      const redirectParams = new URLSearchParams({ success: "true" });
      if (finalConnectionId) {
        redirectParams.set("connectionId", finalConnectionId);
      }
      if (createdPolicyId) {
        redirectParams.set("policyId", createdPolicyId);
      }

      return reply.redirect(
        `${WEB_URL}/dashboard/connections?${redirectParams.toString()}`,
      );
    },
  );

  /**
   * POST /connections/:id/revoke
   * Revokes a connection: zeros encrypted tokens and sets status to 'revoked'.
   * The row is kept for audit trail but all sensitive material is permanently destroyed.
   * Blocks new token vending (Model A) and execution (Model B) immediately.
   */
  fastify.post<{ Params: { id: string } }>(
    "/connections/:id/revoke",
    {
      schema: {
        tags: ["Connections"],
        summary: "Revoke connection",
        description: "Revokes a connection immediately. All encrypted tokens are permanently destroyed (set to null). The connection row is kept for audit trail. Revoked connections are hidden from the list endpoint.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              connection: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  provider: { type: "string" },
                  label: { type: "string" },
                  status: { type: "string", enum: ["revoked"] },
                },
              },
              auditId: { type: "string", format: "uuid" },
            },
          },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid, sub } = request.user;
      const { id } = request.params;

      // Fetch the connection scoped to workspace
      const [connection] = await db
        .select({
          id: connections.id,
          status: connections.status,
          provider: connections.provider,
          service: connections.service,
          label: connections.label,
        })
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .limit(1);

      if (!connection) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      if (connection.status === "revoked") {
        return reply.code(409).send({ error: "Connection is already revoked" });
      }

      // Zero all sensitive material and mark as revoked.
      // The row stays for audit trail but tokens are permanently destroyed.
      await db
        .update(connections)
        .set({ status: "revoked", encryptedTokens: null, updatedAt: new Date() })
        .where(eq(connections.id, id));

      // Cascade revoke: also revoke all policies associated with this connection
      // This ensures agents can't use revoked connections
      await db
        .update(policies)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(eq(policies.connectionId, id));

      request.log.info(
        { connectionId: id, provider: connection.provider, service: connection.service, label: connection.label },
        "conn.revoked",
      );

      // Log audit event (async — fire-and-forget, don't block response)
      const { auditId } = logConnectionRevoked(sub, id, {
        provider: connection.provider,
        label: connection.label,
        previousStatus: connection.status,
      });

      return {
        connection: {
          id: connection.id,
          provider: connection.provider,
          label: connection.label,
          status: "revoked" as const,
        },
        auditId,
      };
    },
  );

  /**
   * PUT /connections/:id/credentials
   * Updates a stored inline credential for bot_token/api_key connections.
   */
  fastify.put<{ Params: { id: string }; Body: { botToken?: string; apiKey?: string; appKey?: string; email?: string; siteUrl?: string } }>(
    "/connections/:id/credentials",
    {
      schema: {
        tags: ["Connections"],
        summary: "Update inline credentials",
        description:
          "Updates a stored credential for bot token and API key connections without requiring the connection to enter needs_reauth first. " +
          "OAuth connections must still use the normal reauth flow.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              connection: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  provider: { type: "string" },
                  service: { type: "string" },
                  label: { type: "string" },
                  status: { type: "string" },
                },
              },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      const [connection] = await db
        .select({
          id: connections.id,
          provider: connections.provider,
          service: connections.service,
          label: connections.label,
          status: connections.status,
        })
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .limit(1);

      if (!connection) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      if (connection.status === "revoked") {
        return reply.code(409).send({ error: "Cannot update a revoked connection" });
      }

      const entry = SERVICE_CATALOG[connection.service as ServiceId];
      if (!entry || (entry.credentialType !== "bot_token" && entry.credentialType !== "api_key")) {
        return reply.code(409).send({ error: "This connection uses OAuth reauthorization instead of inline credential updates" });
      }

      try {
        return await updateInlineCredential(connection, request.body);
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Failed to update credential" });
      }
    },
  );

  /**
   * POST /connections/:id/reauth
   * Starts a reauth flow for a connection with status 'needs_reauth'.
   * Preserves existing connection metadata and policies.
   * Works like /connections/start but links to the existing connection.
   */
  fastify.post<{ Params: { id: string }; Body: { botToken?: string; apiKey?: string; appKey?: string; email?: string; siteUrl?: string } }>(
    "/connections/:id/reauth",
    {
      schema: {
        tags: ["Connections"],
        summary: "Reauth a connection",
        description:
          "Reauthenticates a connection. For OAuth providers, returns an authorization URL for redirect. " +
          "For bot_token/api_key providers, accepts the new credential inline and updates immediately.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              pendingConnectionId: { type: "string", format: "uuid" },
              authorizationUrl: { type: "string", format: "uri" },
              connection: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  provider: { type: "string" },
                  service: { type: "string" },
                  label: { type: "string" },
                  status: { type: "string" },
                },
              },
              message: { type: "string" },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
          409: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      // Fetch the connection scoped to workspace
      const [connection] = await db
        .select({
          id: connections.id,
          provider: connections.provider,
          service: connections.service,
          label: connections.label,
          status: connections.status,
          grantedScopes: connections.grantedScopes,
          oauthAppId: connections.oauthAppId,
        })
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .limit(1);

      if (!connection) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      if (connection.status === "revoked") {
        return reply
          .code(409)
          .send({ error: "Cannot reauth a revoked connection" });
      }

      const entry = SERVICE_CATALOG[connection.service as ServiceId];

      // Bot token providers: accept new token inline, validate, encrypt, update
      if (entry?.credentialType === "bot_token") {
        try {
          const result = await updateInlineCredential(connection, request.body);
          return { ...result, message: `${entry.displayName} reconnected successfully` };
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : "Failed to reconnect" });
        }
      }

      // API key providers: accept new key inline, encrypt, update
      if (entry?.credentialType === "api_key") {
        try {
          const result = await updateInlineCredential(connection, request.body);
          return { ...result, message: `${entry.displayName} reconnected successfully` };
        } catch (err) {
          return reply.code(400).send({ error: err instanceof Error ? err.message : "Failed to reconnect" });
        }
      }

      // OAuth providers: redirect-based reauth flow
      request.log.info(
        { connectionId: id, provider: connection.provider, service: connection.service },
        "conn.reauth.start",
      );
      const { connector } = await resolveConnector({
        provider: connection.provider,
        oauthAppId: connection.oauthAppId,
        workspaceId: wid,
      });

      // Collect scopes from ALL policies on this connection's action templates.
      // A connection may be shared by multiple agents with different templates
      // (e.g., one with outlook-read, another with outlook-manage). We need the
      // union so every agent works after reauth. Falls back to the service's
      // templates or grantedScopes if no policies exist.
      const connPolicies = await db
        .select({ actionTemplateId: policies.actionTemplateId })
        .from(policies)
        .where(eq(policies.connectionId, connection.id));

      let baseScopes: string[];
      const templateIds = [...new Set(connPolicies.map((p) => p.actionTemplateId).filter(Boolean))] as string[];
      if (templateIds.length > 0) {
        const scopeSet = new Set<string>();
        for (const tid of templateIds) {
          const template = getActionTemplate(tid);
          if (template?.scopes) {
            for (const s of template.scopes) scopeSet.add(s);
          }
        }
        baseScopes = scopeSet.size > 0 ? [...scopeSet] : connection.grantedScopes ?? [];
      } else {
        // No policies — fall back to the service's templates (union of read + manage scopes)
        const serviceTemplates = getActionTemplatesForService(connection.service);
        if (serviceTemplates.length > 0) {
          const scopeSet = new Set<string>();
          for (const t of serviceTemplates) {
            for (const s of t.scopes) scopeSet.add(s);
          }
          baseScopes = [...scopeSet];
        } else {
          baseScopes = connection.grantedScopes ?? [];
        }
      }

      // Microsoft's grantedScopes won't include offline_access (it's a meta-scope),
      // but it must be requested to get a refresh token.
      const scopes = connection.provider === "microsoft" && !baseScopes.includes("offline_access")
        ? [...baseScopes, "offline_access"]
        : baseScopes;
      const expiresAt = new Date(Date.now() + PENDING_EXPIRY_MS);

      const state = randomBytes(32).toString("base64url");
      const codeVerifier = randomBytes(32).toString("base64url");
      const codeChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");

      const redirectUri = `${WEB_URL}/api/connections/callback`;

      const { authorizationUrl } = await connector.createAuthorizationUrl({
        redirectUri,
        scopes,
        state,
        codeChallenge,
        codeChallengeMethod: "S256",
      });

      const [pending] = await db
        .insert(pendingConnections)
        .values({
          provider: connection.provider as "google" | "microsoft",
          service: connection.service,
          workspaceId: wid,
          state,
          codeVerifier,
          scopes,
          label: connection.label,
          metadata: {
            redirectUri,
            reauthConnectionId: connection.id,
            ...(connection.oauthAppId && { byaOauthAppId: connection.oauthAppId }),
          },
          expiresAt,
        })
        .returning({ id: pendingConnections.id });

      return {
        pendingConnectionId: pending!.id,
        authorizationUrl,
      };
    },
  );

  /**
   * POST /connections/:id/test
   * Tests a connection's credentials by calling a lightweight provider endpoint.
   */
  fastify.post<{ Params: { id: string } }>(
    "/connections/:id/test",
    {
      schema: {
        tags: ["Connections"],
        summary: "Test a connection's credentials",
        description: "Verifies the connection is working by calling a lightweight provider endpoint. Returns a success message or an error with a hint for resolution.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              provider: { type: "string" },
              detail: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              error: { type: "string" },
              hint: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;

      const [connection] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .limit(1);

      if (!connection) {
        return reply.code(404).send({ ok: false, error: "Connection not found" });
      }

      request.log.debug(
        { connectionId: id, provider: connection.provider },
        "conn.test",
      );

      if (connection.status === "revoked") {
        return reply.code(400).send({ ok: false, error: "Connection is revoked", hint: "Delete this connection and create a new one." });
      }

      if (!getEncryptionKey()) {
        return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
      }

      // Decrypt stored tokens
      if (!connection.encryptedTokens) {
        return reply.code(400).send({ ok: false, error: "No credentials stored for this connection", hint: "Reconnect to provide new credentials." });
      }
      const encryptedPayload = JSON.parse(connection.encryptedTokens);
      const decryptedJson = decrypt(encryptedPayload, getEncryptionKey());
      const tokens = JSON.parse(decryptedJson) as Record<string, string | undefined>;

      const entry = SERVICE_CATALOG[connection.service as ServiceId];
      if (!entry) {
        return reply.code(400).send({ ok: false, error: `Unknown service: ${connection.service}` });
      }

      try {
        if (entry.credentialType === "bot_token") {
          const botToken = tokens.botToken ?? "";
          if (!botToken) {
            return reply.code(400).send({ ok: false, error: "No bot token found in stored credentials", hint: "Reconnect to provide a new token." });
          }

          if (entry.provider === "telegram") {
            const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
            const data = (await res.json()) as { ok: boolean; result?: { username?: string }; description?: string };
            if (!data.ok) {
              await db.update(connections).set({ status: "needs_reauth", updatedAt: new Date() }).where(eq(connections.id, id));
              request.log.info({ connectionId: id, provider: "telegram", healthy: false }, "conn.test.result");
              return reply.code(400).send({ ok: false, error: `Telegram bot token is invalid: ${data.description ?? "unknown error"}`, hint: "Get a new token from @BotFather and reconnect." });
            }
            if (connection.status !== "healthy") {
              db.update(connections).set({ status: "healthy", updatedAt: new Date() }).where(eq(connections.id, id))
                .then(() => {}).catch((err) => request.log.error(err, "Failed to mark connection healthy after test"));
            }
            request.log.info({ connectionId: id, provider: "telegram", healthy: true }, "conn.test.result");
            return { ok: true, provider: "telegram", detail: `Bot @${data.result?.username} is active` };
          }

          if (entry.provider === "slack") {
            const res = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: { "Authorization": `Bearer ${botToken}`, "Content-Type": "application/json" },
            });
            const data = (await res.json()) as { ok: boolean; error?: string; team?: string };
            if (!data.ok) {
              await db.update(connections).set({ status: "needs_reauth", updatedAt: new Date() }).where(eq(connections.id, id));
              request.log.info({ connectionId: id, provider: "slack", healthy: false }, "conn.test.result");
              return reply.code(400).send({ ok: false, error: `Slack token is invalid: ${data.error ?? "unknown error"}`, hint: "Get a new Bot User OAuth Token from your Slack App settings." });
            }
            if (connection.status !== "healthy") {
              db.update(connections).set({ status: "healthy", updatedAt: new Date() }).where(eq(connections.id, id))
                .then(() => {}).catch((err) => request.log.error(err, "Failed to mark connection healthy after test"));
            }
            request.log.info({ connectionId: id, provider: "slack", healthy: true }, "conn.test.result");
            return { ok: true, provider: "slack", detail: `Connected to ${data.team ?? "Slack workspace"}` };
          }

          return reply.code(400).send({ ok: false, error: `No test implemented for provider: ${entry.provider}` });
        }

        if (entry.credentialType === "email") {
          const emailTokens = JSON.parse(decryptedJson) as {
            email?: string;
            imap?: { host: string; port: number; tls?: boolean; username: string; password: string };
          };
          if (!emailTokens.imap) {
            return reply.code(400).send({ ok: false, error: "No IMAP credentials found", hint: "Reconnect to provide IMAP server details." });
          }
          const { host, port, tls, username, password } = emailTokens.imap;
          try {
            const { ImapFlow } = await import("imapflow");
            const client = new ImapFlow({
              host,
              port,
              secure: tls !== false,
              auth: { user: username, pass: password },
              logger: false as any,
              tls: { rejectUnauthorized: false },
            });
            await client.connect();
            const mailboxCount = (await client.list()).length;
            await client.logout();
            if (connection.status !== "healthy") {
              db.update(connections).set({ status: "healthy", updatedAt: new Date() }).where(eq(connections.id, id))
                .then(() => {}).catch((err) => request.log.error(err, "Failed to mark email connection healthy"));
            }
            request.log.info({ connectionId: id, provider: "email", healthy: true }, "conn.test.result");
            return { ok: true, provider: "email", detail: `IMAP connected — ${mailboxCount} folder(s) found` };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "IMAP connection failed";
            request.log.warn({ connectionId: id, provider: "email", err: msg }, "conn.test.email.failed");
            await db.update(connections).set({ status: "needs_reauth", updatedAt: new Date() }).where(eq(connections.id, id));
            return reply.code(400).send({ ok: false, error: `IMAP test failed: ${msg}`, hint: "Check your server settings and credentials." });
          }
        }

        if (entry.credentialType === "api_key") {
          // Anthropic can be connected via API key OR OAuth (setup token flow).
          // API key stores { apiKey }, OAuth stores { accessToken, refreshToken }.
          const apiKey = tokens.apiKey ?? tokens.accessToken ?? "";
          if (!apiKey) {
            return reply.code(400).send({ ok: false, error: "No API key found in stored credentials", hint: "Reconnect to provide a new key." });
          }

          // Test API key by calling a lightweight provider endpoint.
          // HTTP 401 → key is invalid (mark needs_reauth).
          // HTTP 200 → key is valid (show provider-specific detail).
          // Other status → key may be valid but something is off (report status).
          const providerTests: Record<string, { url: string; method?: string; headers: Record<string, string>; body?: string; invalidStatuses: number[]; hint: string }> = {
            anthropic: {
              url: "https://api.anthropic.com/v1/messages",
              method: "POST",
              headers: { ...buildProviderAuthHeaders("anthropic", apiKey), "content-type": "application/json" },
              body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
              invalidStatuses: [401, 403],
              hint: "Get a new key at console.anthropic.com and reconnect.",
            },
            openai: {
              url: "https://api.openai.com/v1/models",
              headers: buildProviderAuthHeaders("openai", apiKey),
              invalidStatuses: [401],
              hint: "Get a new key at platform.openai.com and reconnect.",
            },
            gemini: {
              url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
              headers: {},
              invalidStatuses: [400, 401, 403],
              hint: "Get a new key at aistudio.google.com/apikey and reconnect.",
            },
            openrouter: {
              url: "https://openrouter.ai/api/v1/models",
              headers: buildProviderAuthHeaders("openrouter", apiKey),
              invalidStatuses: [401],
              hint: "Get a new key at openrouter.ai/settings/keys and reconnect.",
            },
            notion: {
              url: "https://api.notion.com/v1/users/me",
              headers: buildProviderAuthHeaders("notion", apiKey),
              invalidStatuses: [401],
              hint: "Check your token at notion.so/profile/integrations and reconnect.",
            },
            trello: {
              url: `https://api.trello.com/1/members/me?key=${encodeURIComponent(tokens.appKey ?? "")}&token=${encodeURIComponent(apiKey)}`,
              headers: {},
              invalidStatuses: [401, 400],
              hint: "Check your Trello API key and user token, then reconnect.",
            },
            jira: {
              url: `https://${tokens.siteUrl ?? ""}/rest/api/3/myself`,
              headers: { Authorization: `Basic ${Buffer.from(`${tokens.email ?? ""}:${apiKey}`).toString("base64")}`, Accept: "application/json" },
              invalidStatuses: [401, 403],
              hint: "Check your Jira site URL, email, and API token. Generate a token at id.atlassian.com/manage/api-tokens.",
            },
          };

          const testConfig = providerTests[entry.provider];
          if (!testConfig) {
            return reply.code(400).send({ ok: false, error: `No test implemented for provider: ${entry.provider}` });
          }

          // Use undici (same as vault.ts) for Anthropic to avoid any fetch() vs undici header differences.
          // Other providers use fetch() which works fine for GET requests.
          let status: number;
          let resBody: string;
          if (entry.provider === "anthropic") {
            const { statusCode, body } = await undiciRequest(testConfig.url, {
              method: "POST",
              headers: testConfig.headers,
              body: testConfig.body ?? null,
            });
            status = statusCode;
            resBody = await body.text();
          } else {
            const fetchOpts: RequestInit = { headers: testConfig.headers };
            if (testConfig.method) fetchOpts.method = testConfig.method;
            if (testConfig.body) fetchOpts.body = testConfig.body;
            const res = await fetch(testConfig.url, fetchOpts);
            status = res.status;
            resBody = await res.text();
          }

          if (testConfig.invalidStatuses.includes(status)) {
            const keyPrefix = apiKey.slice(0, 10);
            request.log.warn({ connectionId: id, provider: entry.provider, status, keyPrefix, errorBody: resBody.slice(0, 300), tokenKeys: Object.keys(tokens) }, "API key test failed");
            await db.update(connections).set({ status: "needs_reauth", updatedAt: new Date() }).where(eq(connections.id, id));
            request.log.info({ connectionId: id, provider: entry.provider, healthy: false }, "conn.test.result");
            return reply.code(400).send({ ok: false, error: `${entry.displayName} API key is invalid or expired (HTTP ${status}).`, hint: testConfig.hint });
          }

          // Key was accepted — any non-auth-error means the credential is valid.
          // Mark healthy if the connection was in needs_reauth.
          if (connection.status !== "healthy") {
            db.update(connections).set({ status: "healthy", updatedAt: new Date() }).where(eq(connections.id, id))
              .then(() => {}).catch((err) => request.log.error(err, "Failed to mark connection healthy after test"));
          }

          request.log.info({ connectionId: id, provider: entry.provider, healthy: true }, "conn.test.result");

          // Extract provider-specific detail from successful responses
          if (status >= 200 && status < 300) {
            try {
              const json = JSON.parse(resBody);
              if (entry.provider === "notion") {
                return { ok: true, provider: entry.provider, detail: `Connected as ${(json as { name?: string }).name ?? "Notion bot"}` };
              }
            } catch { /* ignore parse errors */ }
            return { ok: true, provider: entry.provider, detail: `${entry.displayName} API key is valid` };
          }

          // Non-200 but not an auth error — key is valid.
          return { ok: true, provider: entry.provider, detail: `${entry.displayName} API key is valid` };
        }

        if (entry.credentialType === "oauth") {
          // OAuth tokens expire (~1hr). Refresh before testing, same as vault.ts.
          if (!tokens.refreshToken) {
            await markConnectionNeedsReauth(id, "No refresh token available", request.log);
            return reply.code(400).send({ ok: false, error: "No refresh token available.", hint: "Click 'Reconnect' to re-authorize." });
          }

          let accessToken: string;
          try {
            const { connector } = await resolveConnector({
              provider: entry.provider,
              oauthAppId: connection.oauthAppId,
              workspaceId: wid,
            });
            const newTokenSet = await connector.refresh(tokens.refreshToken);
            accessToken = newTokenSet.accessToken;
            request.log.debug({ connectionId: id, provider: entry.provider }, "OAuth token refreshed for test");

            // Persist refreshed tokens (fire-and-forget)
            const updatedTokenPayload = JSON.stringify({
              accessToken: newTokenSet.accessToken,
              refreshToken: newTokenSet.refreshToken ?? tokens.refreshToken,
              tokenType: newTokenSet.tokenType,
              expiresAt: newTokenSet.expiresAt,
            });
            const encryptedTokens = JSON.stringify(encrypt(updatedTokenPayload, getEncryptionKey()));
            db.update(connections)
              .set({ encryptedTokens, updatedAt: new Date() })
              .where(eq(connections.id, id))
              .then(() => {})
              .catch((err) => request.log.error(err, "Failed to update OAuth tokens after refresh"));
          } catch (err) {
            const message = err instanceof Error ? err.message : "Token refresh failed";
            request.log.warn({ err, connectionId: id, provider: entry.provider }, "OAuth token refresh failed during test");
            await markConnectionNeedsReauth(id, message, request.log);
            request.log.info({ connectionId: id, provider: entry.provider, healthy: false }, "conn.test.result");
            return reply.code(400).send({ ok: false, error: `${entry.displayName} token refresh failed: ${message}`, hint: "Click 'Reconnect' to re-authorize." });
          }

          // Use service-specific test endpoints that match the granted scopes.
          // Google userinfo requires openid/email scopes which service connections don't have.
          const serviceTestEndpoints: Record<string, { url: string; parseDetail: (json: unknown) => string }> = {
            "google-gmail": {
              url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
              parseDetail: (json) => {
                const d = json as { emailAddress?: string };
                return `Connected as ${d.emailAddress ?? "Gmail user"}`;
              },
            },
            "google-calendar": {
              url: "https://www.googleapis.com/calendar/v3/calendars/primary",
              parseDetail: (json) => {
                const d = json as { summary?: string };
                return `Connected to ${d.summary ?? "primary calendar"}`;
              },
            },
            "google-drive": {
              url: "https://www.googleapis.com/drive/v3/about?fields=user",
              parseDetail: (json) => {
                const d = json as { user?: { emailAddress?: string } };
                return `Connected as ${d.user?.emailAddress ?? "Drive user"}`;
              },
            },
            "google-sheets": {
              url: "https://www.googleapis.com/drive/v3/about?fields=user",
              parseDetail: (json) => {
                const d = json as { user?: { emailAddress?: string } };
                return `Connected as ${d.user?.emailAddress ?? "Sheets user"}`;
              },
            },
            "google-docs": {
              url: "https://www.googleapis.com/drive/v3/about?fields=user",
              parseDetail: (json) => {
                const d = json as { user?: { emailAddress?: string } };
                return `Connected as ${d.user?.emailAddress ?? "Docs user"}`;
              },
            },
            "microsoft-teams": {
              url: "https://graph.microsoft.com/v1.0/me",
              parseDetail: (json) => {
                const d = json as { displayName?: string; mail?: string };
                return `Connected as ${d.displayName ?? d.mail ?? "Teams user"}`;
              },
            },
            "microsoft-outlook-mail": {
              url: "https://graph.microsoft.com/v1.0/me",
              parseDetail: (json) => {
                const d = json as { displayName?: string; mail?: string };
                return `Connected as ${d.displayName ?? d.mail ?? "Outlook user"}`;
              },
            },
            "microsoft-outlook-calendar": {
              url: "https://graph.microsoft.com/v1.0/me",
              parseDetail: (json) => {
                const d = json as { displayName?: string; mail?: string };
                return `Connected as ${d.displayName ?? d.mail ?? "Outlook user"}`;
              },
            },
            "microsoft-onedrive": {
              url: "https://graph.microsoft.com/v1.0/me",
              parseDetail: (json) => {
                const d = json as { displayName?: string; mail?: string };
                return `Connected as ${d.displayName ?? d.mail ?? "OneDrive user"}`;
              },
            },
            "microsoft-outlook-contacts": {
              url: "https://graph.microsoft.com/v1.0/me",
              parseDetail: (json) => {
                const d = json as { displayName?: string; mail?: string };
                return `Connected as ${d.displayName ?? d.mail ?? "Contacts user"}`;
              },
            },
          };

          const service = connection.service as string;
          const testEndpoint = serviceTestEndpoints[service];
          if (!testEndpoint) {
            return reply.code(400).send({ ok: false, error: `No test implemented for service: ${service}` });
          }

          const res = await fetch(testEndpoint.url, {
            headers: { "Authorization": `Bearer ${accessToken}` },
          });

          if (res.status === 401) {
            await db.update(connections).set({ status: "needs_reauth", updatedAt: new Date() }).where(eq(connections.id, id));
            request.log.info({ connectionId: id, provider: entry.provider, healthy: false }, "conn.test.result");
            return reply.code(400).send({ ok: false, error: `${entry.displayName} token is invalid after refresh (HTTP 401).`, hint: "Click 'Reconnect' to re-authorize." });
          }

          // Token refresh succeeded and provider didn't reject — mark healthy
          if (connection.status !== "healthy") {
            db.update(connections).set({ status: "healthy", updatedAt: new Date() }).where(eq(connections.id, id))
              .then(() => {}).catch((err) => request.log.error(err, "Failed to mark connection healthy after test"));
          }

          request.log.info({ connectionId: id, provider: entry.provider, healthy: true }, "conn.test.result");

          if (res.ok) {
            const json = await res.json();
            return { ok: true, provider: entry.provider, detail: testEndpoint.parseDetail(json) };
          }

          // Non-200 but not 401 — token was accepted but something else is off
          return { ok: true, provider: entry.provider, detail: `${entry.displayName} token is valid (API returned HTTP ${res.status})` };
        }

        return reply.code(400).send({ ok: false, error: `Unknown credential type: ${entry.credentialType}` });
      } catch {
        return reply.code(400).send({ ok: false, error: `Could not reach ${entry.provider} API. Please try again later.`, hint: "This may be a temporary network issue." });
      }
    },
  );

  /**
   * POST /connections/:id/lookup
   * Look up channels or users from a Slack connection using the stored bot token.
   */
  fastify.post<{ Params: { id: string }; Body: { type: "channels" | "users" } }>(
    "/connections/:id/lookup",
    {
      schema: {
        tags: ["Connections"],
        summary: "Look up channels or users for a connection",
        description:
          "Uses the stored bot token to fetch channels or users from Slack. " +
          "Returns a normalized list with IDs and display names for use in the policy wizard.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Connection ID" },
          },
        },
        body: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string", enum: ["channels", "users"], description: "What to look up" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    displayName: { type: "string" },
                    isPrivate: { type: "boolean" },
                    isBot: { type: "boolean" },
                    memberCount: { type: "number" },
                  },
                },
              },
            },
          },
          400: {
            type: "object",
            properties: {
              error: { type: "string" },
              hint: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;
      const { type } = request.body;

      const [connection] = await db
        .select()
        .from(connections)
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .limit(1);

      if (!connection) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      if (connection.provider !== "slack") {
        return reply.code(400).send({ error: "Lookup is only supported for Slack connections", hint: "This endpoint requires a Slack bot connection." });
      }

      if (connection.status === "revoked") {
        return reply.code(400).send({ error: "Connection is revoked", hint: "Delete this connection and create a new one." });
      }

      if (!getEncryptionKey()) {
        return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
      }

      if (!connection.encryptedTokens) {
        return reply.code(400).send({ error: "No credentials stored for this connection", hint: "Reconnect to provide new credentials." });
      }

      let botToken: string;
      try {
        const encryptedPayload = JSON.parse(connection.encryptedTokens);
        const decryptedJson = decrypt(encryptedPayload, getEncryptionKey());
        const tokens = JSON.parse(decryptedJson) as Record<string, string | undefined>;
        botToken = tokens.botToken ?? "";
      } catch (err) {
        return reply500(reply, err, "Failed to decrypt connection tokens", { request });
      }

      if (!botToken) {
        return reply.code(400).send({ error: "No bot token found in stored credentials", hint: "Reconnect to provide a new token." });
      }

      try {
        if (type === "channels") {
          const res = await fetch("https://slack.com/api/conversations.list", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${botToken}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({ types: "public_channel,private_channel", exclude_archived: true, limit: 200 }),
          });
          const data = await res.json() as {
            ok: boolean;
            error?: string;
            channels?: Array<{ id: string; name: string; is_private?: boolean; num_members?: number }>;
          };

          if (!data.ok) {
            return reply.code(400).send({ error: `Slack API error: ${data.error ?? "unknown"}`, hint: "Check that the bot has the channels:read scope." });
          }

          const items = (data.channels ?? []).map((ch) => ({
            id: ch.id,
            name: ch.name,
            isPrivate: ch.is_private ?? false,
            memberCount: ch.num_members ?? 0,
          }));

          return { items };
        }

        if (type === "users") {
          const res = await fetch("https://slack.com/api/users.list", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${botToken}`,
              "Content-Type": "application/json; charset=utf-8",
            },
            body: JSON.stringify({ limit: 200 }),
          });
          const data = await res.json() as {
            ok: boolean;
            error?: string;
            members?: Array<{
              id: string;
              name: string;
              real_name?: string;
              profile?: { display_name?: string };
              is_bot?: boolean;
              deleted?: boolean;
            }>;
          };

          if (!data.ok) {
            return reply.code(400).send({ error: `Slack API error: ${data.error ?? "unknown"}`, hint: "Check that the bot has the users:read scope." });
          }

          const items = (data.members ?? [])
            .filter((m) => !m.deleted && m.id !== "USLACKBOT")
            .map((m) => ({
              id: m.id,
              name: m.name,
              displayName: m.profile?.display_name || m.real_name || m.name,
              isBot: m.is_bot ?? false,
            }));

          return { items };
        }

        return reply.code(400).send({ error: `Unknown lookup type: ${type}` });
      } catch {
        return reply.code(400).send({ error: "Could not reach Slack API. Please try again later.", hint: "This may be a temporary network issue." });
      }
    },
  );

  /**
   * PUT /connections/:id/label
   * Updates the display label of a connection.
   */
  fastify.put<{ Params: { id: string } }>(
    "/connections/:id/label",
    {
      schema: {
        tags: ["Connections"],
        summary: "Update connection label",
        description: "Renames a connection by updating its display label.",
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", format: "uuid", description: "Connection ID" },
          },
        },
        body: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string", minLength: 1, description: "New display label for the connection" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              connection: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  label: { type: "string" },
                },
              },
            },
          },
          400: { type: "object", properties: { error: { type: "string" } } },
          404: { type: "object", properties: { error: { type: "string" } } },
        },
      },
    },
    async (request, reply) => {
      const { wid } = request.user;
      const { id } = request.params;
      const body = request.body as { label?: string };

      if (!body.label || typeof body.label !== "string" || body.label.trim().length === 0) {
        return reply.code(400).send({ error: "label is required and must be a non-empty string" });
      }

      const [updated] = await db
        .update(connections)
        .set({ label: body.label.trim(), updatedAt: new Date() })
        .where(and(eq(connections.id, id), eq(connections.workspaceId, wid)))
        .returning({ id: connections.id, label: connections.label });

      if (!updated) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      return { connection: updated };
    },
  );
}
