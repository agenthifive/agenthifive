import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyBaseLogger } from "fastify";
import { reply500 } from "../utils/reply-error";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq, ne, and, gte, count, sql } from "drizzle-orm";
import { request as undiciRequest } from "undici";
import { db } from "../db/client";
import { connections } from "../db/schema/connections";
import { policies } from "../db/schema/policies";
import { agents } from "../db/schema/agents";
import { auditEvents } from "../db/schema/audit-events";
import { approvalRequests } from "../db/schema/approval-requests";
import { promptHistoryQuarantines } from "../db/schema/prompt-history-quarantines";
import { decrypt, type EncryptedPayload } from "@agenthifive/security";
import { markConnectionNeedsReauth } from "./connections";
import { resolveConnector } from "../utils/oauth-connector-factory";
import { checkTimeWindows } from "../utils/time-windows";
import { createNotification } from "../services/notifications";
import { sendApprovalNotifications } from "../services/external-notifications";
import {
  canonicalizeUrl,
  checkHostSafety,
  DEFAULT_MAX_PAYLOAD_SIZE_BYTES,
  DEFAULT_MAX_RESPONSE_SIZE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../utils/ssrf-protection";
import {
  logTokenVended,
  logTokenVendDenied,
  logExecutionRequested,
  logExecutionCompleted,
  logExecutionError,
  logExecutionDenied,
  logRateLimitExceeded,
  logApprovalRequested,
} from "../services/audit";
import { isGmailSendUrl, parseGmailSendPayload } from "../utils/gmail-mime";
import {
  isGmailAttachmentUrl,
  isOutlookAttachmentUrl,
  extractGmailAttachmentIds,
  extractGmailMessageAction,
  extractOutlookAttachmentIds,
  resolveGmailAttachmentMetadata,
  resolveGmailMessageMetadata,
  resolveOutlookAttachmentMetadata,
  type AttachmentMetadata,
  type EmailActionMetadata,
} from "../utils/attachment-metadata";
import { isTelegramBotUrl, parseTelegramSendPayload, extractTelegramChatId, isTelegramGetUpdatesUrl, filterTelegramUpdates } from "../utils/telegram-message";
import { handleEmailRequest, type EmailCredentials } from "./email-provider";
import {
  isSlackApiUrl,
  isSlackReadMethod,
  isSlackConversationsListUrl,
  isSlackConversationsHistoryUrl,
  extractSlackChannel,
  filterSlackChannels,
  filterSlackMessages,
  parseSlackSendPayload,
} from "../utils/slack-message";
import { SERVICE_CATALOG, type ServiceId, type PolicyRules, type GuardTrigger } from "@agenthifive/contracts";
import { checkAnomalies, type AnomalyContext } from "../services/anomaly-detector";
import {
  getCompiledRules,
  evaluateRequestRules,
  filterResponse,
  extractPromptText,
  type CompiledPolicyRules,
  type RedactionInfo,
} from "../services/policy-engine";
import { createStreamFilter } from "../utils/stream-filter";
import { LLM_PROVIDERS, PROVIDER_TO_SERVICE, buildProviderAuthHeaders } from "../utils/provider-auth";
import { refreshAnthropicToken } from "../utils/anthropic-oauth";
import {
  isMicrosoftGraphUrl,
  isTeamsChatSendUrl,
  isTeamsChannelSendUrl,
  extractTeamsChatId,
  extractTeamsChannelInfo,
  parseTeamsMessagePayload,
} from "../utils/microsoft-teams";

import { getEncryptionKey } from "../services/encryption-key";

/** Explicit type for connection rows — avoids drizzle inference depth limits in large handlers */

/**
 * Compute a SHA-256 fingerprint of the normalized request payload so that
 * approval redemption can verify the agent re-submitted the identical request.
 * Covers body, query params, and forwarded headers — the three agent-controlled
 * inputs that affect what the vault sends to the provider.
 *
 * Keys are sorted at every level to guarantee the same logical payload always
 * produces the same hash regardless of JSON key ordering.
 */
function computeRequestFingerprint(
  requestBody: unknown,
  query: Record<string, string> | undefined,
  headers: Record<string, string> | undefined,
): string {
  const canonical = JSON.stringify({
    body: requestBody ?? null,
    headers: headers ? Object.fromEntries(Object.entries(headers).sort()) : null,
    query: query ? Object.fromEntries(Object.entries(query).sort()) : null,
  }, (_key, value) => {
    // Sort object keys at every nesting level for deterministic output
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort());
    }
    return value;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL = "Redact PII outside trusted recipient scope";

function stripTrustedRecipientPiiRedaction(compiledRules: CompiledPolicyRules): CompiledPolicyRules {
  const response = compiledRules.response.filter(
    (rule) => rule.label !== TRUSTED_RECIPIENT_PII_REDACT_RULE_LABEL,
  );
  return response.length === compiledRules.response.length
    ? compiledRules
    : { ...compiledRules, response };
}
interface ConnectionRow {
  id: string;
  provider: string;
  service: string;
  status: string;
  encryptedTokens: string | null;
  workspaceId: string;
  oauthAppId: string | null;
  metadata: unknown;
}

interface AllowlistEntry {
  baseUrl: string;
  methods: string[];
  pathPatterns: string[];
}

function buildTransparentProxyTargetUrl(baseUrl: string, providerPath: string, query?: Record<string, string>): string {
  const base = new URL(baseUrl);
  const normalizedPath = providerPath.replace(/^\/+/, "");
  const basePath = base.pathname.replace(/\/+$/, "");
  const baseSegments = basePath.split("/").filter(Boolean);
  const pathSegments = normalizedPath.split("/").filter(Boolean);

  let finalSegments = pathSegments;
  if (baseSegments.length > 0) {
    const prefixedByBase = baseSegments.every((segment, index) => pathSegments[index] === segment);
    finalSegments = prefixedByBase ? pathSegments : [...baseSegments, ...pathSegments];
  }

  base.pathname = `/${finalSegments.join("/")}`;
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      base.searchParams.set(key, value);
    }
  }
  return base.toString();
}

/**
 * Trusted cross-origin redirect domains per provider.
 * Some provider APIs legitimately redirect to a different domain for content
 * delivery. For example, Microsoft Graph redirects OneDrive `/content` requests
 * to the tenant's SharePoint domain (*.sharepoint.com).
 *
 * When a cross-origin redirect targets one of these patterns, the vault follows
 * the redirect server-side instead of blocking it. The agent never sees the
 * redirect URL.
 */
const TRUSTED_REDIRECT_PATTERNS: Record<string, RegExp[]> = {
  microsoft: [
    /^https:\/\/[a-z0-9-]+-my\.sharepoint\.com$/,  // OneDrive personal
    /^https:\/\/[a-z0-9-]+\.sharepoint\.com$/,      // SharePoint sites
  ],
};

/**
 * Check if a redirect origin is trusted for the given provider.
 */
function isTrustedRedirect(provider: string, redirectOrigin: string): boolean {
  const patterns = TRUSTED_REDIRECT_PATTERNS[provider];
  if (!patterns) return false;
  return patterns.some((re) => re.test(redirectOrigin));
}

/**
 * Check if a URL path matches a path pattern with wildcards.
 * Supports ** (any path, including slashes) and * (single segment).
 */
function matchPathPattern(urlPath: string, pattern: string): boolean {
  if (urlPath === pattern) return true;
  if (!pattern.includes("*")) return false;

  // Trailing /** should also match the base path itself (no trailing slash).
  // e.g. /messages/** matches /messages, /messages/123, /messages/123/attachments
  const adjusted = pattern.endsWith("/**")
    ? pattern.slice(0, -3) + "{/**}"
    : pattern;

  const regexStr =
    "^" +
    adjusted
      .split(/(\*\*|\*|\{\/\*\*\})/)
      .map((part) =>
        part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "{/**}" ? "(/.*)?": part.replace(/\./g, "\\."),
      )
      .join("") +
    "$";

  return new RegExp(regexStr).test(urlPath);
}

/**
 * Validate a Model B request against policy allowlists (default-deny).
 * Returns { allowed: true } or { allowed: false, reason, hint } with
 * near-miss detection to help AI agents self-correct.
 */
function checkAllowlists(
  allowlists: AllowlistEntry[],
  method: string,
  url: string,
): { allowed: true } | { allowed: false; reason: string; hint?: string } {
  if (allowlists.length === 0) {
    return { allowed: false, reason: "No allowlist rules configured — all requests are denied by default" };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { allowed: false, reason: `Invalid request URL: ${url}` };
  }

  // Track near-misses for actionable hints (most-specific wins)
  let nearMiss: { level: number; hint: string } | null = null;
  // level 0 = no origin match, 1 = origin match but method wrong, 2 = origin+method but path wrong

  let anyOriginMatched = false;

  for (const entry of allowlists) {
    // Check base URL matches
    let entryBaseUrl: URL;
    try {
      entryBaseUrl = new URL(entry.baseUrl);
    } catch {
      continue; // skip malformed allowlist entries
    }

    // Compare origin (protocol + host + port)
    // Support wildcard hosts (e.g. https://*.atlassian.net) for variable-base-URL providers like Jira
    if (parsedUrl.origin !== entryBaseUrl.origin) {
      if (!entryBaseUrl.hostname.includes("*") || parsedUrl.protocol !== entryBaseUrl.protocol || parsedUrl.port !== entryBaseUrl.port) continue;
      // Glob-match hostname: *.atlassian.net matches example.atlassian.net
      const pattern = entryBaseUrl.hostname.replace(/\./g, "\\.").replace(/\*/g, "[^.]+");
      if (!new RegExp(`^${pattern}$`).test(parsedUrl.hostname)) continue;
    }

    // Check if the path starts with the base URL path (if base URL has a path)
    const basePath = entryBaseUrl.pathname.replace(/\/$/, ""); // trim trailing slash
    if (basePath && !parsedUrl.pathname.startsWith(basePath)) continue;

    anyOriginMatched = true;

    // Check HTTP method — if wrong, record near-miss but check if path matches first
    const methodMatches = entry.methods.includes(method);

    // Check path patterns
    const urlPath = parsedUrl.pathname;
    let pathMatches = false;
    for (const pattern of entry.pathPatterns) {
      if (matchPathPattern(urlPath, pattern)) {
        pathMatches = true;
        break;
      }
    }

    if (methodMatches && pathMatches) {
      return { allowed: true };
    }

    // Path matched but method is wrong — most specific near-miss
    if (pathMatches && !methodMatches) {
      if (!nearMiss || nearMiss.level < 2) {
        nearMiss = {
          level: 2,
          hint: `The path matched an allowlist rule, but method ${method} is not allowed. Allowed methods for this path: ${entry.methods.join(", ")}.`,
        };
      }
    }

    // Method matched but path didn't — second-most specific
    if (methodMatches && !pathMatches) {
      if (!nearMiss || nearMiss.level < 1) {
        nearMiss = {
          level: 1,
          hint: `The host and method matched, but path ${parsedUrl.pathname} is not in the allowed paths. Allowed patterns: ${entry.pathPatterns.join(", ")}.`,
        };
      }
    }
  }

  // No origin matched at all
  if (!anyOriginMatched && !nearMiss) {
    const allowedHosts = [...new Set(
      allowlists
        .map((e) => { try { return new URL(e.baseUrl).host; } catch { return null; } })
        .filter(Boolean),
    )];
    nearMiss = {
      level: 0,
      hint: allowedHosts.length > 0
        ? `No allowlist rules for host ${parsedUrl.host}. Allowed hosts: ${allowedHosts.join(", ")}.`
        : `No valid allowlist rules configured.`,
    };
  }

  return {
    allowed: false,
    reason: `Request denied: ${method} ${url} does not match any allowlist rule`,
    ...(nearMiss && { hint: nearMiss.hint }),
  };
}

/**
 * Strips user-controlled headers that could be used for smuggling or impersonation.
 */
function sanitizeHeaders(
  userHeaders: Record<string, string> | undefined,
): Record<string, string> {
  if (!userHeaders) return {};

  const forbidden = new Set([
    "authorization",
    "cookie",
    "host",
    "x-api-key",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "x-ah5-bypass-pii-redaction",
    "transfer-encoding",
    "connection",
    "upgrade",
    // Prevent compression issues: undici.request() does NOT auto-decompress,
    // so forwarding accept-encoding from the agent would cause garbled response bodies.
    "accept-encoding",
    "content-encoding",
    // Content-length from the caller may not match the re-serialized body.
    "content-length",
    // Anthropic OAuth identity headers — the SDK (pi-ai) may set these when it
    // detects an OAuth-like token (e.g. vault JWT starting with "ey").  We strip
    // them here and let buildProviderAuthHeaders() re-add the correct set based
    // on the *actual* stored credential type.  Forwarding these with an API-key
    // auth causes Anthropic to reject with 401 "OAuth not supported".
    "anthropic-dangerous-direct-browser-access",
    "x-app",
  ]);

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(userHeaders)) {
    const lower = key.toLowerCase();
    if (!forbidden.has(lower)) {
      sanitized[lower] = value;
    }
  }
  return sanitized;
}

export default async function vaultRoutes(fastify: FastifyInstance) {
  // ── Anomaly detection hook ──────────────────────────────────────
  // Stash context on the request during the handler, then run anomaly checks
  // fire-and-forget after the response is sent. This avoids touching every
  // audit call site individually.
  fastify.decorateRequest("anomalyCtx", null);
  fastify.addHook("onResponse", (request, reply) => {
    const ctx = (request as unknown as Record<string, unknown>).anomalyCtx as AnomalyContext | null;
    if (ctx) {
      // Determine decision from response status code
      const statusCode = reply.statusCode;
      ctx.decision = statusCode >= 500 ? "error" : statusCode >= 400 ? "denied" : "allowed";
      checkAnomalies(ctx).catch((err) => { fastify.log.warn({ err }, "Anomaly check failed"); });
    }
  });

  /**
   * POST /vault/execute
   * Execution gateway — supports Model A (token vending) and Model B (brokered proxy).
   */
  fastify.post("/vault/execute", {
    schema: {
      tags: ["Vault"],
      summary: "Execute via gateway",
      description:
        "Unified execution gateway supporting Model A (token vending) and Model B (brokered proxy).\n\n" +
        "**Model A** returns a short-lived access token (max 1 hour) for the agent to use directly. Never returns the refresh token.\n\n" +
        "**Model B** executes an HTTP request to the provider API on the agent's behalf. The agent never receives credentials. " +
        "Requests are validated against policy allowlists (default-deny), checked for SSRF, and may require step-up approval for write actions.\n\n" +
        "### TypeScript Example\n" +
        "```typescript\n" +
        "// Model A: Token vending\n" +
        "const res = await fetch('/vault/execute', {\n" +
        "  method: 'POST',\n" +
        "  headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },\n" +
        "  body: JSON.stringify({ model: 'A', connectionId: 'uuid' })\n" +
        "});\n" +
        "const { accessToken, expiresIn, auditId } = await res.json();\n\n" +
        "// Model B: Brokered proxy\n" +
        "const res = await fetch('/vault/execute', {\n" +
        "  method: 'POST',\n" +
        "  headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },\n" +
        "  body: JSON.stringify({\n" +
        "    model: 'B', connectionId: 'uuid',\n" +
        "    method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages'\n" +
        "  })\n" +
        "});\n" +
        "const { status, body, auditId } = await res.json();\n" +
        "```",
      body: {
        type: "object",
        required: ["model"],
        properties: {
          model: { type: "string", enum: ["A", "B"], description: "Execution model" },
          connectionId: { type: "string", format: "uuid", description: "Connection to use (required for multi-account services like Google/Microsoft)" },
          service: { type: "string", description: "Service ID for singleton resolution (e.g. 'telegram'). Use instead of connectionId for singleton services." },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"], description: "HTTP method (Model B only)" },
          url: { type: "string", description: "Target URL (Model B). Full URL for HTTP providers, relative path for protocol providers (e.g., email-imap: /messages?folder=INBOX)." },
          query: { type: "object", additionalProperties: { type: "string" }, description: "Query parameters (Model B)" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "Request headers (Model B). Authorization, Cookie, Host are stripped." },
          body: { description: "Request body (Model B)" },
          stream: { type: "boolean", description: "Stream the provider response directly instead of wrapping in a JSON envelope. Works with any provider — LLM completions, event feeds, long-running operations. Response rules (PII redaction, field filtering) are applied in real-time per event/chunk." },
          download: { type: "boolean", description: "Return the raw binary response instead of wrapping in a JSON envelope. Use for file downloads (e.g., Google Drive alt=media). The response will have the provider's Content-Type and Content-Disposition headers." },
          approvalId: { type: "string", format: "uuid", description: "Approval request ID from a previously approved step-up request. When provided, the vault verifies the approval is valid and skips the require_approval guard." },
          bypassPiiRedaction: { type: "boolean", description: "Request approval to send the original unredacted content when a request-side PII redaction rule would normally redact it." },
          requestFullFields: { type: "boolean", description: "Request full contact fields including PII (phone numbers, addresses, birthdays). Only available on balanced (standard) tier contacts policies. Triggers step-up approval; once approved, re-submit with both approvalId and requestFullFields: true." },
        },
      },
      // Response schema intentionally omitted — fast-json-stringify strips properties
      // without explicit types (like the polymorphic `body` field in Model B responses).
      // Using plain JSON.stringify ensures the provider response body is passed through intact.
    },
  }, async (request, reply) => {
    // Debug: track when the inbound connection closes (client/proxy disconnect)
    const handlerStart = Date.now();
    reply.raw.on("close", () => {
      request.log.info(
        { elapsed: Date.now() - handlerStart, aborted: request.raw.destroyed },
        "vault.exec.connection.closed",
      );
    });

    const { sub } = request.user;
    const body = request.body as {
      model?: string;
      connectionId?: string;
      service?: string;
      // Model B fields
      method?: string;
      url?: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: unknown;
      stream?: boolean;
      download?: boolean;
      approvalId?: string;
      bypassPiiRedaction?: boolean;
      requestFullFields?: boolean;
    };

    request.log.info(
      { model: body.model, connectionId: body.connectionId, service: body.service, agentId: request.user.agentId },
      "vault.entry",
    );

    if (!body.model) {
      return reply.code(400).send({ error: "model is required" });
    }

    if (!body.connectionId && !body.service) {
      return reply.code(400).send({ error: "Either connectionId or service must be provided" });
    }

    if (body.model !== "A" && body.model !== "B") {
      return reply.code(400).send({ error: "model must be 'A' or 'B'" });
    }

    // Model B requires additional fields
    if (body.model === "B") {
      if (!body.method || !body.url) {
        return reply.code(400).send({ error: "Model B requires method and url" });
      }
      const validMethods = ["GET", "POST", "PUT", "DELETE", "PATCH"];
      if (!validMethods.includes(body.method)) {
        return reply.code(400).send({ error: `Invalid method: ${body.method}. Must be one of: ${validMethods.join(", ")}` });
      }
      // Skip URL canonicalization for relative paths (e.g., /messages, /folders).
      // Protocol providers like email-imap use virtual paths that aren't HTTP URLs.
      // The path is prefixed with a synthetic base later in handleModelB.
      if (body.url.startsWith("/")) {
        // Relative path — will be prefixed in handleModelB for email-imap
      } else {
        try {
          body.url = canonicalizeUrl(body.url);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Invalid URL";
          return reply.code(400).send({ error: `Invalid URL: ${message}` });
        }
      }
    }

    // Resolve connectionId: either directly provided or via singleton service lookup
    let connectionId: string;

    if (body.connectionId) {
      connectionId = body.connectionId;
    } else {
      // body.service is guaranteed to exist here (validated above)
      const catalogEntry = SERVICE_CATALOG[body.service as ServiceId];
      if (!catalogEntry) {
        return reply.code(400).send({ error: `Unknown service: ${body.service}` });
      }
      if (!catalogEntry.singleton) {
        return reply.code(400).send({ error: `Service '${body.service}' is not a singleton. Provide connectionId instead.` });
      }
      // Find the singleton connection for this workspace
      const [conn] = await db
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.service, body.service as ServiceId),
            eq(connections.workspaceId, request.user.wid),
            eq(connections.status, "healthy"),
          ),
        )
        .limit(1);
      if (!conn) {
        return reply.code(404).send({ error: `No healthy connection found for service '${body.service}'` });
      }
      connectionId = conn.id;
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    // Find the connection scoped to the user's workspace
    const connRows: ConnectionRow[] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, connectionId),
          eq(connections.workspaceId, request.user.wid),
        ),
      )
      .limit(1) as unknown as ConnectionRow[];
    const connection = connRows[0];

    if (!connection) {
      return reply.code(404).send({ error: "Connection not found" });
    }

    request.log.info(
      { connectionId, provider: connection.provider, service: connection.service, status: connection.status },
      "vault.connection",
    );

    if (connection.status === "revoked") {
      return reply.code(409).send({ error: "Connection has been revoked" });
    }

    if (connection.status === "needs_reauth") {
      return reply.code(409).send({ error: "Connection requires reauthentication" });
    }

    // Find policies that match this connection and belong to user's workspace.
    // When authenticated via agent API key, only match policies for that specific agent.
    // Always filter out revoked policies.
    const policyFilters = [
      eq(policies.connectionId, connectionId),
      eq(agents.workspaceId, request.user.wid),
      eq(policies.status, "active"),
      ne(agents.status, "disabled"),
    ];
    if (request.user.agentId) {
      policyFilters.push(eq(policies.agentId, request.user.agentId));
    }

    const matchingPolicies = await db
      .select({
        id: policies.id,
        agentId: policies.agentId,
        allowedModels: policies.allowedModels,
        allowlists: policies.allowlists,
        timeWindows: policies.timeWindows,
        rateLimits: policies.rateLimits,
        stepUpApproval: policies.stepUpApproval,
        defaultMode: policies.defaultMode,
        rules: policies.rules,
        providerConstraints: policies.providerConstraints,
      })
      .from(policies)
      .innerJoin(agents, eq(policies.agentId, agents.id))
      .where(and(...policyFilters));

    // Find first policy that allows the requested model
    const policy = matchingPolicies.find((p) =>
      p.allowedModels.includes(body.model!),
    );

    if (!policy) {
      const allModels = [...new Set(matchingPolicies.flatMap((p) => p.allowedModels as string[]))];
      return reply.code(403).send({
        error: `No policy allows Model ${body.model} for this connection`,
        hint: allModels.length > 0
          ? `This connection has policies allowing Model ${allModels.join(" and ")}. Use model: "${allModels[0]}" instead.`
          : undefined,
      });
    }

    request.log.info(
      { policyId: policy.id, allowedModels: policy.allowedModels, defaultMode: policy.defaultMode, stepUpApproval: policy.stepUpApproval },
      "vault.policy",
    );

    // Stash anomaly context for the onResponse hook
    (request as unknown as Record<string, unknown>).anomalyCtx = {
      agentId: policy.agentId,
      connectionId,
      workspaceId: request.user.wid,
      decision: "allowed", // overridden in onResponse based on status code
    } satisfies AnomalyContext;

    // Check time windows
    const timeWindows = (policy.timeWindows ?? []) as Array<{
      dayOfWeek: number;
      startHour: number;
      endHour: number;
      timezone: string;
    }>;
    const timeCheck = checkTimeWindows(timeWindows);
    request.log.debug(
      { allowed: timeCheck.allowed, windowCount: timeWindows.length },
      "vault.timeWindow",
    );
    if (!timeCheck.allowed) {
      const { auditId } = body.model === "A"
        ? logTokenVendDenied(sub, policy.agentId, connectionId, { reason: timeCheck.reason, model: body.model })
        : logExecutionDenied(sub, policy.agentId, connectionId, { model: body.model, method: "", url: "", reason: timeCheck.reason });

      return reply.code(403).send({ error: timeCheck.reason, auditId });
    }

    // ──────────────── Model A: Token Vending ────────────────
    if (body.model === "A") {
      return handleModelA(fastify, request, reply, {
        sub,
        connectionId,
        connection,
        policy,
      });
    }

    // ──────────────── Model B: Brokered Proxy ────────────────
    const modelBCtx: Parameters<typeof handleModelB>[3] = {
      sub,
      connectionId,
      connection,
      policy,
      method: body.method!,
      url: body.url!,
      workspaceId: request.user.wid,
      providerConstraints: policy.providerConstraints,
    };
    if (body.query !== undefined) modelBCtx.query = body.query;
    if (body.headers !== undefined) modelBCtx.headers = body.headers;
    if (body.body !== undefined) modelBCtx.requestBody = body.body;
    if (body.stream) modelBCtx.stream = body.stream;
    if (body.download) modelBCtx.download = body.download;
    if (body.approvalId) modelBCtx.approvalId = body.approvalId;
    if (body.bypassPiiRedaction) modelBCtx.bypassPiiRedaction = true;
    if (body.requestFullFields) modelBCtx.requestFullFields = true;
    if (request.headers["x-ah5-session-key"] && typeof request.headers["x-ah5-session-key"] === "string") {
      modelBCtx.sessionKey = request.headers["x-ah5-session-key"];
    }
    modelBCtx.rawRequest = request;

    return handleModelB(fastify, request, reply, modelBCtx);
  });

  // ──────────────── Transparent LLM Proxy (vault-integrated) ────────────────

  /**
   * ALL /vault/llm/:provider/*
   *
   * Transparent reverse proxy for LLM API calls — convenience route for AI SDKs.
   * The SDK sends requests as if talking to the LLM provider directly (just with
   * a different base URL). This route translates that into vault/execute parameters
   * and runs through the full policy engine (same code path as vault/execute).
   *
   * Example: SDK configured with baseUrl="{vault}/v1/vault/llm/anthropic" sends
   * POST {baseUrl}/v1/messages → this route builds the target URL as
   * https://api.anthropic.com/v1/messages and delegates to handleModelB().
   */
  fastify.all<{
    Params: { provider: string; "*": string };
  }>("/vault/llm/:provider/*", {
    schema: {
      tags: ["Vault"],
      summary: "LLM proxy (vault-integrated)",
      description:
        "Transparent reverse proxy for LLM API calls. " +
        "Authenticates the caller, resolves the LLM connection, runs the full policy engine " +
        "(rate limits, time windows, allowlists, request rules including prompt injection detection), " +
        "injects the provider API key, forwards the request, and streams the response back " +
        "with real-time response rule filtering (PII redaction, field filtering).",
      params: {
        type: "object",
        required: ["provider", "*"],
        properties: {
          provider: { type: "string", description: "LLM provider name (anthropic, openai, gemini, openrouter)" },
          "*": { type: "string", description: "Path to forward to the upstream provider" },
        },
      },
    },
  }, async (request, reply) => {
    const { sub, wid } = request.user;
    const provider = request.params.provider;
    const providerPath = request.params["*"];

    request.log.info(
      { provider, providerPath, agentId: request.user.agentId },
      "vault.llm.entry",
    );

    // 1. Validate provider
    const providerConfig = LLM_PROVIDERS[provider];
    if (!providerConfig) {
      return reply.code(404).send({ error: `Unsupported LLM provider: ${provider}` });
    }

    const serviceId = PROVIDER_TO_SERVICE[provider];
    if (!serviceId) {
      return reply.code(404).send({ error: `No service mapping for provider: ${provider}` });
    }

    if (!getEncryptionKey()) {
      return reply500(reply, new Error("Encryption key not configured"), "Encryption key not configured", { request });
    }

    const query = normalizeProxyQuery(request.query);
    // 2. Build target URL from hardcoded provider base + agent-supplied path
    const targetUrl = buildTransparentProxyTargetUrl(providerConfig.baseUrl, providerPath, query);

    // 3. Detect streaming from request shape
    const body = request.body as Record<string, unknown> | undefined;
    const isStreaming = detectLlmProxyStreaming(provider, providerPath, query, body);

    // LLM request diagnostics — LOG_LEVEL=debug to enable.
    // Only logs sizes, roles, and model params — never conversation content.
    if (body && typeof body === "object") {
      const sizeBreakdown: Record<string, number> = {};
      for (const [key, value] of Object.entries(body)) {
        sizeBreakdown[key] = Buffer.byteLength(JSON.stringify(value), "utf8");
      }
      request.log.debug(sizeBreakdown, "vault.llm.bodyBreakdown");

      const { messages: _m, system: _s, tools: _t, ...smallFields } = body;
      request.log.debug(smallFields, "vault.llm.params");

      const messages = body.messages;
      if (Array.isArray(messages)) {
        const msgSummary = messages.map((msg: Record<string, unknown>, i: number) => {
          const size = Buffer.byteLength(JSON.stringify(msg), "utf8");
          const content = msg.content;
          let contentType: string = typeof content;
          if (Array.isArray(content)) {
            const blockTypes = content.map((b: Record<string, unknown>) => b.type ?? "unknown");
            contentType = `array[${blockTypes.join(",")}]`;
          }
          return { i, role: msg.role, contentType, size };
        });
        request.log.debug({ messageCount: messages.length, messages: msgSummary }, "vault.llm.messagesBreakdown");
      }
    }

    // 4. Resolve singleton connection for this service
    const [conn] = await db
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(
          eq(connections.service, serviceId as ServiceId),
          eq(connections.workspaceId, wid),
          eq(connections.status, "healthy"),
        ),
      )
      .limit(1);

    if (!conn) {
      return reply.code(404).send({ error: `No healthy ${provider} connection found for this workspace` });
    }

    const connectionId = conn.id;

    // 5. Fetch full connection details
    const connRows: ConnectionRow[] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId))
      .limit(1) as unknown as ConnectionRow[];
    const connection = connRows[0];

    if (!connection) {
      return reply.code(404).send({ error: "Connection not found" });
    }

    // 6. Find policies that match this connection and allow Model B.
    // When authenticated via agent API key, only match policies for that specific agent.
    // Always filter out revoked policies.
    const llmPolicyFilters = [
      eq(policies.connectionId, connectionId),
      eq(agents.workspaceId, wid),
      eq(policies.status, "active"),
      ne(agents.status, "disabled"),
    ];
    if (request.user.agentId) {
      llmPolicyFilters.push(eq(policies.agentId, request.user.agentId));
    }

    const matchingPolicies = await db
      .select({
        id: policies.id,
        agentId: policies.agentId,
        allowedModels: policies.allowedModels,
        allowlists: policies.allowlists,
        timeWindows: policies.timeWindows,
        rateLimits: policies.rateLimits,
        stepUpApproval: policies.stepUpApproval,
        defaultMode: policies.defaultMode,
        rules: policies.rules,
        providerConstraints: policies.providerConstraints,
      })
      .from(policies)
      .innerJoin(agents, eq(policies.agentId, agents.id))
      .where(and(...llmPolicyFilters));

    const policy = matchingPolicies.find((p) =>
      p.allowedModels.includes("B"),
    );

    if (!policy) {
      return reply.code(403).send({
        error: "No policy allows Model B for this LLM connection",
        hint: `Create a policy for the ${provider} connection that allows Model B.`,
      });
    }

    request.log.debug(
      { policyId: policy.id, model: "B" },
      "vault.llm.policy",
    );

    // Stash anomaly context for the onResponse hook
    (request as unknown as Record<string, unknown>).anomalyCtx = {
      agentId: policy.agentId,
      connectionId,
      workspaceId: wid,
      decision: "allowed",
    } satisfies AnomalyContext;

    // 7. Extract provider-specific headers from the incoming HTTP request.
    // The SDK sets headers like anthropic-beta, anthropic-version, x-goog-api-key
    // that must reach the upstream provider. Auth headers are stripped by sanitizeHeaders.
    const incomingHeaders: Record<string, string> = {};
    let bypassPiiRedaction = false;
    let approvalId: string | undefined;
    let sessionKey: string | undefined;
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === "string") {
        if (key.toLowerCase() === "x-ah5-bypass-pii-redaction") {
          bypassPiiRedaction = value === "1" || value.toLowerCase() === "true";
          continue;
        }
        if (key.toLowerCase() === "x-ah5-approval-id") {
          approvalId = value;
          continue;
        }
        if (key.toLowerCase() === "x-ah5-session-key") {
          sessionKey = value;
          continue;
        }
        incomingHeaders[key] = value;
      }
    }

    request.log.info(
      {
        provider,
        providerPath,
        agentId: request.user.agentId,
        connectionId,
        hasSessionKey: Boolean(sessionKey),
        hasApprovalId: Boolean(approvalId),
        bypassPiiRedaction,
        isStreaming,
      },
      "vault.llm.handoff",
    );

    // 8. Delegate to the same handleModelB → executeModelBRequest pipeline
    const modelBCtx: Parameters<typeof handleModelB>[3] = {
      sub,
      connectionId,
      connection,
      policy,
      method: request.method as string,
      url: targetUrl,
      workspaceId: wid,
      providerConstraints: policy.providerConstraints,
      headers: incomingHeaders,
      stream: isStreaming,
      rawRequest: request,
      transparentProxy: true,
      bypassPiiRedaction,
    };
    if (query) modelBCtx.query = query;
    if (approvalId) modelBCtx.approvalId = approvalId;
    if (sessionKey) modelBCtx.sessionKey = sessionKey;

    if (body && typeof body === "object") {
      modelBCtx.requestBody = body;
    }

    request.log.info(
      {
        provider,
        providerPath,
        agentId: request.user.agentId,
        connectionId,
        hasModelBSessionKey: Boolean(modelBCtx.sessionKey),
        hasModelBApprovalId: Boolean(modelBCtx.approvalId),
      },
      "vault.llm.modelBCtx",
    );

    return handleModelB(fastify, request, reply, modelBCtx);
  });

  // ──────────────── Backward-compat redirect from old LLM proxy path ────────────────

  fastify.all<{
    Params: { provider: string; "*": string };
  }>("/llm/proxy/:provider/*", {
    config: { skipAuth: true },
    schema: { hide: true },
  }, async (request, reply) => {
    const { provider } = request.params;
    const path = request.params["*"];
    // 308 preserves HTTP method (POST stays POST)
    reply.redirect(`/v1/vault/llm/${provider}/${path}`, 308);
  });
}

// ────────────────────── Model A Handler ──────────────────────

async function handleModelA(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: {
    sub: string;
    connectionId: string;
    connection: {
      id: string;
      provider: string;
      service: string;
      encryptedTokens: string | null;
      oauthAppId: string | null;
      workspaceId: string;
    };
    policy: {
      agentId: string;
      rateLimits: unknown;
    };
  },
) {
  const { sub, connectionId, connection, policy } = ctx;

  // Check rate limits
  const rateLimits = policy.rateLimits as {
    maxRequestsPerHour?: number;
  } | null;

  if (rateLimits?.maxRequestsPerHour) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [result] = await db
      .select({ total: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.agentId, policy.agentId),
          eq(auditEvents.connectionId, connectionId),
          eq(auditEvents.action, "token_vended"),
          gte(auditEvents.timestamp, oneHourAgo),
        ),
      );

    const currentCount = result?.total ?? 0;
    const allowed = currentCount < rateLimits.maxRequestsPerHour;
    request.log.debug(
      { limit: rateLimits.maxRequestsPerHour, currentCount, allowed },
      "vault.modelA.rateLimit",
    );

    if (!allowed) {
      const [oldest] = await db
        .select({ ts: auditEvents.timestamp })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.agentId, policy.agentId),
            eq(auditEvents.connectionId, connectionId),
            eq(auditEvents.action, "token_vended"),
            gte(auditEvents.timestamp, oneHourAgo),
          ),
        )
        .orderBy(auditEvents.timestamp)
        .limit(1);

      const retryAfter = oldest
        ? Math.max(1, Math.ceil((oldest.ts.getTime() + 3600_000 - Date.now()) / 1000))
        : 3600;

      const { auditId } = logRateLimitExceeded(sub, policy.agentId, connectionId, {
        model: "A",
        limit: rateLimits.maxRequestsPerHour,
        currentCount,
      });

      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send({
        error: `Rate limit exceeded: ${rateLimits.maxRequestsPerHour} tokens per hour`,
        hint: `Rate limited at ${rateLimits.maxRequestsPerHour} requests/hour. Retry after ${retryAfter} seconds.`,
        retryAfter,
        auditId,
      });
    }
  }

  // Decrypt the stored tokens (null means tokens were zeroed on revoke)
  if (!connection.encryptedTokens) {
    return reply.code(409).send({ error: "Connection tokens have been revoked" });
  }

  let tokenData: {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt?: string;
    botToken?: string;
    apiKey?: string;
    appKey?: string;
    email?: string;
    siteUrl?: string;
  };
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    tokenData = JSON.parse(decrypted);
  } catch (err) {
    return reply500(reply, err, "Failed to decrypt connection tokens", { request, extra: { connectionId } });
  }

  request.log.info(
    {
      provider: connection.provider,
      service: connection.service,
      tokenType: tokenData.botToken ? "bot" : tokenData.apiKey ? "api-key" : "oauth",
      hasRefreshToken: !!tokenData.refreshToken,
    },
    "vault.modelA.credential",
  );

  // Telegram uses bot tokens — Model A returns the bot token directly
  if (connection.provider === "telegram") {
    if (!tokenData.botToken) {
      return reply500(reply, new Error("Telegram bot token not found in stored tokens"), "Telegram bot token not found in stored tokens", { request, extra: { connectionId } });
    }

    const { auditId } = logTokenVended(sub, policy.agentId, connectionId, {
      model: "A",
      provider: connection.provider,
      ttl: 3600,
    });

    request.log.info({ connectionId, provider: connection.provider, agentId: policy.agentId, ttl: 3600 }, "vault.modelA.tokenVended");
    return {
      model: "A",
      accessToken: tokenData.botToken,
      tokenType: "Bearer",
      expiresIn: 3600,
      auditId,
    };
  }

  // Anthropic — API keys use x-api-key, OAuth tokens use Bearer
  if (connection.provider === "anthropic") {
    if (!tokenData.apiKey) {
      return reply500(reply, new Error("Anthropic API key not found in stored tokens"), "Anthropic API key not found in stored tokens", { request, extra: { connectionId } });
    }

    const isOAuthToken = tokenData.apiKey.startsWith("sk-ant-oat");
    const { auditId } = logTokenVended(sub, policy.agentId, connectionId, {
      model: "A",
      provider: connection.provider,
      ttl: 3600,
    });

    request.log.info({ connectionId, provider: connection.provider, agentId: policy.agentId, ttl: 3600 }, "vault.modelA.tokenVended");
    return {
      model: "A",
      accessToken: tokenData.apiKey,
      tokenType: isOAuthToken ? "bearer" : "x-api-key",
      expiresIn: 3600,
      auditId,
    };
  }

  // OAuth providers — refresh token to get a fresh access token
  if (!tokenData.refreshToken) {
    await markConnectionNeedsReauth(
      connectionId,
      "No refresh token available",
      request.log,
    );
    return reply.code(409).send({ error: "Connection requires reauthentication (no refresh token)" });
  }

  request.log.info({ provider: connection.provider }, "vault.modelA.tokenRefresh.start");
  let newTokenSet;
  try {
    const { connector } = await resolveConnector({
      provider: connection.provider,
      oauthAppId: connection.oauthAppId,
      workspaceId: connection.workspaceId,
    });
    newTokenSet = await connector.refresh(tokenData.refreshToken);
    request.log.info({ provider: connection.provider, refreshed: true, scopes: newTokenSet.scope }, "vault.modelA.tokenRefresh.result");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token refresh failed";
    request.log.warn({ err, connectionId, provider: connection.provider }, "vault.modelA.tokenRefresh.failed");

    await markConnectionNeedsReauth(
      connectionId,
      message,
      request.log,
    );

    return reply.code(409).send({ error: "Connection requires reauthentication" });
  }

  // Update stored tokens with the new access token
  const updatedTokenPayload = JSON.stringify({
    accessToken: newTokenSet.accessToken,
    refreshToken: newTokenSet.refreshToken ?? tokenData.refreshToken,
    tokenType: newTokenSet.tokenType,
    expiresAt: newTokenSet.expiresAt,
  });

  const { encrypt } = await import("@agenthifive/security");
  const encryptedTokens = JSON.stringify(encrypt(updatedTokenPayload, getEncryptionKey()));

  db.update(connections)
    .set({
      encryptedTokens,
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connectionId))
    .then(() => {})
    .catch((err) => request.log.error(err, "Failed to update connection tokens after refresh"));

  const providerExpiresIn = newTokenSet.expiresAt
    ? Math.max(1, Math.floor((new Date(newTokenSet.expiresAt).getTime() - Date.now()) / 1000))
    : 3600;
  const expiresIn = Math.min(providerExpiresIn, 3600);

  const { auditId } = logTokenVended(sub, policy.agentId, connectionId, {
    model: "A",
    provider: connection.provider,
    ttl: expiresIn,
  });

  request.log.info({ connectionId, provider: connection.provider, agentId: policy.agentId, ttl: expiresIn }, "vault.modelA.tokenVended");
  return {
    model: "A",
    accessToken: newTokenSet.accessToken,
    tokenType: "Bearer",
    expiresIn,
    auditId,
  };
}

// ────────────────────── Model B Handler ──────────────────────

/** Write methods that may trigger step-up approval */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Some APIs use POST for read operations. When `stepUpApproval` is `risk_based`,
 * these should NOT trigger approval — they're reads despite being POST.
 */
function isSafeReadPost(service: string, url: string): boolean {
  // Telegram Bot API uses POST for everything. All get* methods are reads.
  if (service === "telegram") {
    try {
      const path = new URL(url).pathname;
      // Token may be stripped by the proxy: /bot/getUpdates or /bot<token>/getUpdates
      return /^\/bot[^/]*\/get/i.test(path);
    } catch { return false; }
  }

  // Slack Web API uses POST for everything. Read endpoints return data without side effects.
  if (service === "slack") {
    const slackReadMethods = [
      "/api/conversations.history", "/api/conversations.replies",
      "/api/conversations.list", "/api/conversations.info",
      "/api/users.info", "/api/users.list",
      "/api/emoji.list", "/api/pins.list",
      "/api/team.info", "/api/auth.test",
    ];
    try {
      const path = new URL(url).pathname;
      return slackReadMethods.some((m) => path === m || path === `${m}/`);
    } catch { return false; }
  }

  // Notion API uses POST for database queries and search.
  if (service === "notion") {
    try {
      const path = new URL(url).pathname;
      return /^\/v1\/databases\/[^/]+\/query\/?$/.test(path) || path === "/v1/search" || path === "/v1/search/";
    } catch { return false; }
  }

  // LLM APIs use POST for all inference calls — these are stateless and don't mutate external state.
  // Guards (prompt injection, PII, model restriction) provide the actual risk controls.
  if (service === "anthropic-messages") {
    try {
      const path = new URL(url).pathname;
      return /^\/v1\/messages\/?$/.test(path) || /^\/v1\/models\/?/.test(path);
    } catch { return false; }
  }
  if (service === "openai") {
    try {
      const path = new URL(url).pathname;
      return /^\/v1\/chat\/completions\/?$/.test(path)
        || /^\/v1\/embeddings\/?$/.test(path)
        || /^\/v1\/models\/?/.test(path);
    } catch { return false; }
  }
  if (service === "gemini") {
    try {
      const path = new URL(url).pathname;
      // Gemini: /v1beta/models/{model}:generateContent or :streamGenerateContent
      return /:(generate|streamGenerate)Content\/?$/.test(path) || /^\/v1(beta)?\/models\/?/.test(path);
    } catch { return false; }
  }
  if (service === "openrouter") {
    try {
      const path = new URL(url).pathname;
      return /^\/api\/v1\/chat\/completions\/?$/.test(path) || /^\/api\/v1\/models\/?/.test(path);
    } catch { return false; }
  }

  return false;
}

/**
 * Build a guardTrigger for approval records when a body-match rule fires.
 *
 * Extracts a short excerpt around each regex match so the workspace owner
 * can see what triggered the guard without us storing the full request body.
 *
 * For prompt injection: excerpts are stored verbatim (the injection IS the threat).
 * For PII bypass: excerpts would have PII redacted (handled by caller).
 */
/** Map rule labels to human-friendly pattern type names and guard categories. */
const PII_LABEL_PATTERN = /\b(ssn|credit.card|pii|redact)\b/i;

function inferGuardType(label: string): GuardTrigger["type"] {
  return PII_LABEL_PATTERN.test(label) ? "pii_bypass" : "prompt_injection";
}

function normalizeProxyQuery(query: unknown): Record<string, string> | undefined {
  if (!query || typeof query !== "object") return undefined;

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (typeof value === "string") {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string");
      if (typeof first === "string") normalized[key] = first;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      normalized[key] = String(value);
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function detectLlmProxyStreaming(
  provider: string,
  providerPath: string,
  query: Record<string, string> | undefined,
  body: Record<string, unknown> | undefined,
): boolean {
  if (body?.stream === true) return true;

  if (provider === "gemini") {
    const alt = query?.alt?.toLowerCase();
    return /:streamGenerateContent\/?$/.test(providerPath) || alt === "sse";
  }

  return false;
}

/** Map raw regex values to human-readable pattern names. */
function humanizePatternType(regexValue: string | undefined): string {
  if (!regexValue) return "unknown";
  const v = regexValue.toLowerCase();
  if (v.includes("\\d{3}[- ]?\\d{2}[- ]?\\d{4}") || v.includes("ssn")) return "SSN";
  if (v.includes("\\d{4}[- ]?\\d{4}[- ]?\\d{4}") || v.includes("credit")) return "CREDIT_CARD";
  if (v.includes("ignore") || v.includes("override") || v.includes("disregard")) return "INSTRUCTION_OVERRIDE";
  if (v.includes("endoftext") || v.includes("im_start") || v.includes("inst")) return "DELIMITER_INJECTION";
  return regexValue.slice(0, 40);
}

function normalizeQuarantineFragment(fragment: string): string {
  return fragment.replace(/^\.\.\./, "").replace(/\.\.\.$/, "").trim();
}

async function seedPromptHistoryQuarantine(params: {
  approvalId: string;
  workspaceId: string;
  requestDetails: Record<string, unknown>;
}) {
  const sessionKey = typeof params.requestDetails.sessionKey === "string"
    ? params.requestDetails.sessionKey
    : null;
  const guardTrigger = params.requestDetails.guardTrigger as {
    type?: string;
    matches?: Array<{ excerpt?: string }>;
  } | undefined;
  if (!sessionKey || guardTrigger?.type !== "prompt_injection") return;

  const fragments = (guardTrigger.matches ?? [])
    .map((match) => (typeof match.excerpt === "string" ? normalizeQuarantineFragment(match.excerpt) : ""))
    .filter((fragment) => fragment.length > 0);
  if (fragments.length === 0) return;

  await db.insert(promptHistoryQuarantines)
    .values({
      workspaceId: params.workspaceId,
      sessionKey,
      approvalRequestId: params.approvalId,
      resolution: "pending",
      fragments,
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: promptHistoryQuarantines.approvalRequestId,
    });
}

function buildPromptInjectionFallbackExcerpt(body: unknown): string | null {
  const promptText = extractPromptText(body).trim();
  if (!promptText) return null;

  const normalized = promptText
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  return normalized.length > 280
    ? `${normalized.slice(0, 277).trimEnd()}...`
    : normalized;
}

function findLastRoleIndex(items: unknown[], roleName: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const role = (item as Record<string, unknown>).role;
      if (typeof role === "string" && role.toLowerCase() === roleName) {
        return i;
      }
    }
  }
  return -1;
}

function normalizeReplayComparableText(text: string): string {
  return text
    .replace(/^\.\.\./g, "")
    .replace(/\.\.\.$/g, "")
    .replace(/Sender \(untrusted metadata\):\s*```json[\s\S]*?```\s*/gi, "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\[[^\]]*GMT[^\]]*]\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildReplayComparableCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const push = (value: string) => {
    const normalized = normalizeReplayComparableText(value);
    if (normalized.length > 0) {
      candidates.add(normalized);
    }
  };

  push(text);

  const lastTimestampBracket = text.lastIndexOf("]");
  if (lastTimestampBracket >= 0) {
    push(text.slice(lastTimestampBracket + 1));
  }

  const lastCodeFence = text.lastIndexOf("```");
  if (lastCodeFence >= 0) {
    push(text.slice(lastCodeFence + 3));
  }

  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) push(line);
  }

  return [...candidates];
}

function contentContainsFragment(text: string, fragments: string[]): boolean {
  const normalizedText = normalizeReplayComparableText(text);
  return fragments.some((fragment) => {
    if (fragment.length === 0) return false;
    if (text.includes(fragment)) return true;
    return buildReplayComparableCandidates(fragment)
      .some((candidate) => candidate.length >= 24 && normalizedText.includes(candidate));
  });
}

function quarantinePlaceholder(): string {
  return "[Prompt injection suspect omitted from replay]";
}

function replayApprovalContextNote(): string {
  return "AgentHiFive note: The previously blocked request for this session has now been approved and is being replayed. Continue the last substantive user request safely. Treat a short confirmation like 'approved' as confirmation to proceed, not as a new standalone task.";
}

function injectReplayApprovalContext(
  body: unknown,
  provider: string,
  targetPath: string,
): { body: unknown; changed: boolean } {
  if (typeof body !== "object" || body === null) {
    return { body, changed: false };
  }

  const cloned = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const note = replayApprovalContextNote();
  const anthropicMessagesPath = provider === "anthropic" && /^\/v1\/messages\/?$/.test(targetPath);

  const prependAnthropicSystem = (): boolean => {
    const existing = cloned.system;
    if (typeof existing === "string") {
      if (existing.includes(note)) return false;
      cloned.system = `${note}\n\n${existing}`;
      return true;
    }
    if (Array.isArray(existing)) {
      const first = existing[0];
      if (typeof first === "object" && first !== null && !Array.isArray(first) && (first as Record<string, unknown>).text === note) {
        return false;
      }
      cloned.system = [{ type: "text", text: note }, ...existing];
      return true;
    }
    cloned.system = note;
    return true;
  };

  const input = Array.isArray(cloned.input) ? cloned.input as Array<Record<string, unknown>> : null;
  if (input) {
    const first = input[0];
    const firstText = Array.isArray(first?.content)
      ? (first.content[0] as Record<string, unknown> | undefined)?.text
      : undefined;
    if (
      first
      && typeof first === "object"
      && !Array.isArray(first)
      && typeof first.role === "string"
      && first.role.toLowerCase() === "system"
      && firstText === note
    ) {
      return { body: cloned, changed: false };
    }
    input.unshift({
      role: "system",
      content: [{ type: "input_text", text: note }],
    });
    return { body: cloned, changed: true };
  }

  const messages = Array.isArray(cloned.messages) ? cloned.messages as Array<Record<string, unknown>> : null;
  if (messages) {
    if (anthropicMessagesPath) {
      return { body: cloned, changed: prependAnthropicSystem() };
    }
    const first = messages[0];
    if (
      first
      && typeof first === "object"
      && !Array.isArray(first)
      && typeof first.role === "string"
      && first.role.toLowerCase() === "system"
      && first.content === note
    ) {
      return { body: cloned, changed: false };
    }
    messages.unshift({ role: "system", content: note });
    return { body: cloned, changed: true };
  }

  const systemInstruction = (
    typeof cloned.systemInstruction === "object"
    && cloned.systemInstruction !== null
    && !Array.isArray(cloned.systemInstruction)
  )
    ? cloned.systemInstruction as Record<string, unknown>
    : null;
  if (systemInstruction) {
    const parts = Array.isArray(systemInstruction.parts) ? systemInstruction.parts : [];
    const first = parts[0];
    if (typeof first === "object" && first !== null && !Array.isArray(first) && (first as Record<string, unknown>).text === note) {
      return { body: cloned, changed: false };
    }
    systemInstruction.parts = [{ text: note }, ...parts];
    return { body: cloned, changed: true };
  }

  const contents = Array.isArray(cloned.contents) ? cloned.contents as Array<Record<string, unknown>> : null;
  if (contents) {
    cloned.systemInstruction = { parts: [{ text: note }] };
    return { body: cloned, changed: true };
  }

  if (typeof cloned.system === "string" || Array.isArray(cloned.system)) {
    return { body: cloned, changed: prependAnthropicSystem() };
  }

  return { body, changed: false };
}

function sanitizePromptHistoryForReplay(body: unknown, rawFragments: string[]): { body: unknown; changed: boolean } {
  const fragments = rawFragments.map(normalizeQuarantineFragment).filter((fragment) => fragment.length > 0);
  if (fragments.length === 0 || typeof body !== "object" || body === null) {
    return { body, changed: false };
  }

  const cloned = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  let changed = false;
  const placeholder = quarantinePlaceholder();

  const scrubArrayBlocks = (items: unknown[]): void => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (typeof item === "string") {
        if (contentContainsFragment(item, fragments)) {
          items[i] = placeholder;
          changed = true;
        }
        continue;
      }
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;

      const rec = item as Record<string, unknown>;
      if (typeof rec.text === "string" && contentContainsFragment(rec.text, fragments)) {
        rec.text = placeholder;
        changed = true;
      }
      if (Array.isArray(rec.parts)) {
        scrubArrayBlocks(rec.parts);
      }
      if (Array.isArray(rec.content)) {
        scrubArrayBlocks(rec.content);
      }
    }
  };

  if (typeof cloned.system === "string" && contentContainsFragment(cloned.system, fragments)) {
    cloned.system = placeholder;
    changed = true;
  } else if (Array.isArray(cloned.system)) {
    scrubArrayBlocks(cloned.system);
  }

  if (
    typeof cloned.systemInstruction === "object"
    && cloned.systemInstruction !== null
    && !Array.isArray(cloned.systemInstruction)
  ) {
    const systemInstruction = cloned.systemInstruction as Record<string, unknown>;
    if (Array.isArray(systemInstruction.parts)) {
      scrubArrayBlocks(systemInstruction.parts);
    }
  }

  const messages = Array.isArray(cloned.messages) ? cloned.messages as Array<Record<string, unknown>> : null;
  if (messages) {
    const lastUserIndex = findLastRoleIndex(messages, "user");
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object") continue;
      const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";
      if (role === "user" && i === lastUserIndex) continue;

      if (typeof msg.content === "string" && contentContainsFragment(msg.content, fragments)) {
        msg.content = placeholder;
        changed = true;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === "string") continue;
          if (typeof block === "object" && block !== null && !Array.isArray(block)) {
            const rec = block as Record<string, unknown>;
            if (typeof rec.text === "string" && contentContainsFragment(rec.text, fragments)) {
              rec.text = placeholder;
              changed = true;
            }
          }
        }
      }
    }
  }

  const input = Array.isArray(cloned.input) ? cloned.input as Array<Record<string, unknown>> : null;
  if (input) {
    const lastUserIndex = findLastRoleIndex(input, "user");
    for (let i = 0; i < input.length; i++) {
      const item = input[i];
      if (!item || typeof item !== "object") continue;
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      if ((role === "user" || role === "input_user") && i === lastUserIndex) continue;

      if (typeof item.content === "string" && contentContainsFragment(item.content, fragments)) {
        item.content = placeholder;
        changed = true;
      } else if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (typeof block === "string") continue;
          if (typeof block === "object" && block !== null && !Array.isArray(block)) {
            const rec = block as Record<string, unknown>;
            if (typeof rec.text === "string" && contentContainsFragment(rec.text, fragments)) {
              rec.text = placeholder;
              changed = true;
            }
          }
        }
      }

      if (typeof item.input_text === "string" && contentContainsFragment(item.input_text, fragments)) {
        item.input_text = placeholder;
        changed = true;
      }
      if (typeof item.text === "string" && contentContainsFragment(item.text, fragments)) {
        item.text = placeholder;
        changed = true;
      }
    }
  }

  const contents = Array.isArray(cloned.contents) ? cloned.contents as Array<Record<string, unknown>> : null;
  if (contents) {
    const lastUserIndex = findLastRoleIndex(contents, "user");
    for (let i = 0; i < contents.length; i++) {
      const item = contents[i];
      if (!item || typeof item !== "object") continue;
      const role = typeof item.role === "string" ? item.role.toLowerCase() : "";
      if (role === "user" && i === lastUserIndex) continue;

      const parts = Array.isArray(item.parts) ? item.parts : [];
      for (const part of parts) {
        if (typeof part === "object" && part !== null && !Array.isArray(part)) {
          const rec = part as Record<string, unknown>;
          if (typeof rec.text === "string" && contentContainsFragment(rec.text, fragments)) {
            rec.text = placeholder;
            changed = true;
          }
        }
      }
    }
  }

  return { body: cloned, changed };
}

function buildGuardTrigger(
  ruleLabel: string,
  guardMatches: GuardTrigger["matches"] | undefined,
  requestBody?: unknown,
): GuardTrigger | null {
  let matches = guardMatches;
  if (!matches || matches.length === 0) {
    if (inferGuardType(ruleLabel) !== "prompt_injection") {
      return null;
    }

    const excerpt = buildPromptInjectionFallbackExcerpt(requestBody);
    if (!excerpt) {
      return null;
    }

    matches = [
      {
        patternType: "INSTRUCTION_OVERRIDE",
        field: "$prompt_text",
        excerpt,
      },
    ];
  }

  return {
    type: inferGuardType(ruleLabel),
    ruleLabel,
    matches: matches.map((match) => ({
      ...match,
      patternType: humanizePatternType(match.patternType),
    })),
  };
}

function sendTransparentApprovalResponse(
  reply: FastifyReply,
  provider: string,
  targetPath: string,
  approvalRequestId: string,
  reason: string,
  hint: string,
): FastifyReply {
  const message =
    `${reason}. Step-up approval has been requested with approvalRequestId ${approvalRequestId}. ${hint}`;
  const created = Math.floor(Date.now() / 1000);

  reply
    .code(200)
    .header("x-agenthifive-approval-required", "true")
    .header("x-agenthifive-approval-request-id", approvalRequestId);

  if (provider === "anthropic") {
    return reply
      .header("content-type", "application/json")
      .send({
        id: `msg_approval_${approvalRequestId}`,
        type: "message",
        role: "assistant",
        model: "agenthifive-approval-gate",
        content: [{ type: "text", text: message }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
  }

  if (provider === "gemini") {
    return reply
      .header("content-type", "application/json")
      .send({
        candidates: [
          {
            index: 0,
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ text: message }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      });
  }

  if (provider === "openai" && /(^|\/)v1\/responses$/.test(targetPath)) {
    return reply
      .header("content-type", "application/json")
      .send({
        id: `resp_approval_${approvalRequestId}`,
        object: "response",
        created_at: created,
        model: "agenthifive-approval-gate",
        status: "completed",
        output: [
          {
            id: `msg_approval_${approvalRequestId}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: message,
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ],
      });
  }

  return reply
    .header("content-type", "application/json")
    .send({
      id: `chatcmpl-approval-${approvalRequestId}`,
      object: "chat.completion",
      created,
      model: "agenthifive-approval-gate",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: message,
          },
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
}

function sendTransparentApprovalStream(
  reply: FastifyReply,
  provider: string,
  targetPath: string,
  approvalRequestId: string,
  reason: string,
  hint: string,
): void {
  const message =
    `${reason}. Step-up approval has been requested with approvalRequestId ${approvalRequestId}. ${hint}`;
  const created = Math.floor(Date.now() / 1000);

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "x-agenthifive-approval-required": "true",
    "x-agenthifive-approval-request-id": approvalRequestId,
  });

  if (provider === "anthropic") {
    reply.raw.write(`event: message_start\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "message_start",
      message: {
        id: `msg_approval_${approvalRequestId}`,
        type: "message",
        role: "assistant",
        model: "agenthifive-approval-gate",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`);
    reply.raw.write(`event: content_block_start\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}\n\n`);
    reply.raw.write(`event: content_block_delta\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: message },
    })}\n\n`);
    reply.raw.write(`event: content_block_stop\n`);
    reply.raw.write(`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
    reply.raw.write(`event: message_delta\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    })}\n\n`);
    reply.raw.write(`event: message_stop\n`);
    reply.raw.write(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    reply.raw.end();
    return;
  }

  if (provider === "gemini") {
    reply.raw.write(`data: ${JSON.stringify({
      candidates: [
        {
          index: 0,
          content: { role: "model", parts: [{ text: message }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      },
    })}\n\n`);
    reply.raw.end();
    return;
  }

  if (provider === "openai" && /(^|\/)v1\/responses$/.test(targetPath)) {
    reply.raw.write(`event: response.created\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.created",
      response: {
        id: `resp_approval_${approvalRequestId}`,
        object: "response",
        created_at: created,
        model: "agenthifive-approval-gate",
        status: "in_progress",
        output: [],
      },
    })}\n\n`);
    reply.raw.write(`event: response.output_item.added\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: `msg_approval_${approvalRequestId}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    })}\n\n`);
    reply.raw.write(`event: response.content_part.added\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.content_part.added",
      output_index: 0,
      item_id: `msg_approval_${approvalRequestId}`,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    })}\n\n`);
    reply.raw.write(`event: response.output_text.delta\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: `msg_approval_${approvalRequestId}`,
      content_index: 0,
      delta: message,
    })}\n\n`);
    reply.raw.write(`event: response.output_text.done\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.output_text.done",
      output_index: 0,
      item_id: `msg_approval_${approvalRequestId}`,
      content_index: 0,
      text: message,
    })}\n\n`);
    reply.raw.write(`event: response.output_item.done\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: `msg_approval_${approvalRequestId}`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: message,
            annotations: [],
            logprobs: [],
          },
        ],
      },
    })}\n\n`);
    reply.raw.write(`event: response.completed\n`);
    reply.raw.write(`data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: `resp_approval_${approvalRequestId}`,
        object: "response",
        created_at: created,
        model: "agenthifive-approval-gate",
        status: "completed",
        output: [
          {
            id: `msg_approval_${approvalRequestId}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: message,
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ],
      },
    })}\n\n`);
    reply.raw.end();
    return;
  }

  reply.raw.write(`data: ${JSON.stringify({
    id: `chatcmpl-approval-${approvalRequestId}`,
    object: "chat.completion.chunk",
    created,
    model: "agenthifive-approval-gate",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: message },
        finish_reason: null,
      },
    ],
  })}\n\n`);
  reply.raw.write(`data: ${JSON.stringify({
    id: `chatcmpl-approval-${approvalRequestId}`,
    object: "chat.completion.chunk",
    created,
    model: "agenthifive-approval-gate",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  })}\n\n`);
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

/**
 * Parse Outlook sendMail payload into the same EmailMetadata shape used by Gmail.
 * Outlook body: { message: { subject, toRecipients: [{ emailAddress: { address } }], ccRecipients, body: { content } } }
 */
function parseOutlookSendMailPayload(requestBody: unknown): { to: string[]; cc: string[]; from: string; subject: string; bodyPreview: string } | null {
  if (!requestBody || typeof requestBody !== "object") return null;
  const body = requestBody as Record<string, unknown>;
  const message = body.message as Record<string, unknown> | undefined;
  if (!message) return null;

  const subject = typeof message.subject === "string" ? message.subject : "";
  const toRecipients = Array.isArray(message.toRecipients) ? message.toRecipients : [];
  const ccRecipients = Array.isArray(message.ccRecipients) ? message.ccRecipients : [];

  const extractAddresses = (list: unknown[]): string[] =>
    list
      .map((r) => (r as { emailAddress?: { address?: string } })?.emailAddress?.address)
      .filter((a): a is string => typeof a === "string");

  const to = extractAddresses(toRecipients);
  const cc = extractAddresses(ccRecipients);

  if (!subject && to.length === 0) return null;

  const msgBody = message.body as { content?: string } | undefined;
  const bodyPreview = typeof msgBody?.content === "string" ? msgBody.content.slice(0, 100) : "";

  return { to, cc, from: "(me)", subject, bodyPreview };
}

/**
 * Extract a brief human-readable summary from the request body for the approval card.
 * Covers contact updates, calendar events, drive file operations, and other common writes.
 * Returns a short string or null.
 */
function extractGenericMetadata(url: string, method: string, body: Record<string, unknown>): string | null {
  const u = url.toLowerCase();

  // Google Contacts — PATCH /v1/people/c123:updateContact or POST .../createContact
  if (u.includes("people.googleapis.com")) {
    const names = body.names as Array<{ displayName?: string; givenName?: string; familyName?: string }> | undefined;
    if (Array.isArray(names) && names.length > 0) {
      const n = names[0]!;
      const full = [n.givenName, n.familyName].filter(Boolean).join(" ");
      return n.displayName ?? (full || null);
    }
  }

  // Microsoft Contacts — PATCH /v1.0/me/contacts/{id}
  if (u.includes("graph.microsoft.com") && u.includes("/contacts")) {
    const parts = [body.givenName, body.surname].filter(s => typeof s === "string" && s);
    if (parts.length > 0) return parts.join(" ");
    if (typeof body.displayName === "string") return body.displayName;
  }

  // Google Calendar — POST /calendars/.../events
  if (u.includes("googleapis.com") && u.includes("/events")) {
    const summary = body.summary;
    if (typeof summary === "string" && summary) return summary;
  }

  // Microsoft Calendar — POST /me/events or /me/calendar/events
  if (u.includes("graph.microsoft.com") && u.includes("/events")) {
    const subject = body.subject;
    if (typeof subject === "string" && subject) return subject;
  }

  // Google Drive — file name
  if (u.includes("googleapis.com") && (u.includes("/files") || u.includes("/documents") || u.includes("/spreadsheets"))) {
    const name = body.name ?? body.title;
    if (typeof name === "string" && name) return name;
  }

  // OneDrive / SharePoint — file name
  if (u.includes("graph.microsoft.com") && u.includes("/drive")) {
    const name = body.name;
    if (typeof name === "string" && name) return name;
  }

  // Notion — page/database title
  if (u.includes("api.notion.com")) {
    const title = body.title;
    if (typeof title === "string" && title) return title;
    // Notion uses rich text array for titles
    if (Array.isArray(title) && title.length > 0) {
      const plainText = (title[0] as { plain_text?: string })?.plain_text;
      if (plainText) return plainText;
    }
  }

  // Trello — card/list name
  if (u.includes("api.trello.com")) {
    const name = body.name;
    if (typeof name === "string" && name) return name;
  }

  // Jira — issue summary
  if (u.includes("atlassian.net") || u.includes("jira")) {
    const fields = body.fields as Record<string, unknown> | undefined;
    if (fields && typeof fields.summary === "string") return fields.summary;
  }

  // Google Drive — share recipient (POST /files/{id}/permissions)
  if (u.includes("googleapis.com") && u.includes("/permissions")) {
    const email = body.emailAddress;
    const role = body.role;
    if (typeof email === "string") return `Share with ${email}${typeof role === "string" ? ` (${role})` : ""}`;
  }

  // LLM APIs — model name
  if (typeof body.model === "string" && body.model) {
    // Only for known LLM endpoints
    if (u.includes("/v1/messages") || u.includes("/v1/chat/completions") || u.includes(":generatecontent") || u.includes("/api/v1/chat/completions")) {
      return `Model: ${body.model}`;
    }
  }

  return null;
}

/**
 * Determine whether step-up approval is required for this request.
 * - 'always': all requests require approval
 * - 'risk_based': write methods (POST/PUT/PATCH/DELETE) require approval,
 *   UNLESS the request is a known safe read (e.g. Telegram getUpdates, Slack reads)
 * - 'never': no approval needed
 */
function checkStepUpApproval(stepUpApproval: string, method: string, service?: string, url?: string): boolean {
  if (stepUpApproval === "always") return true;
  if (stepUpApproval === "risk_based" && WRITE_METHODS.has(method)) {
    if (service && url && method === "POST" && isSafeReadPost(service, url)) {
      return false;
    }
    return true;
  }
  return false;
}

/** Default approval timeout in milliseconds (30 minutes) */
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Parse a URL to determine if it targets an individual contact.
 * Returns null for list/batch/search endpoints.
 *
 * Google People API:
 *   /v1/people/c1234567890 → contactId "people/c1234567890"
 *   /v1/people/me/connections → null (list)
 *   /v1/people:searchContacts → null (search)
 *
 * Microsoft Graph:
 *   /v1.0/me/contacts/AAMk... → contactId "AAMk..."
 *   /v1.0/me/contacts → null (list)
 */
function parseIndividualContactUrl(rawUrl: string): { contactId: string } | null {
  let pathname: string;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }

  // Google People API: /v1/people/{resourceName} but NOT /v1/people/me/connections or /v1/people:*
  const googleMatch = pathname.match(/^\/v1\/people\/(c\d+)(?:[:/]|$)/);
  if (googleMatch) {
    return { contactId: `people/${googleMatch[1]}` };
  }

  // Microsoft Graph: /v1.0/me/contacts/{contactId} (has a segment after /contacts/)
  const msMatch = pathname.match(/^\/v1\.0\/me\/contacts\/([^/]+)/);
  if (msMatch && msMatch[1] !== "" && !pathname.endsWith("/contacts/")) {
    return { contactId: msMatch[1]! };
  }

  return null;
}

/**
 * Best-effort resolve of a contact's display name from the provider API.
 * Used to show a human-readable name in field step-up approval requests.
 * Returns null on any failure — callers fall back to the raw contact ID.
 */
async function resolveContactDisplayName(
  connection: { provider: string; encryptedTokens: string | null; oauthAppId: string | null; workspaceId: string },
  contactId: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  if (!connection.encryptedTokens) return null;

  let tokenData: { accessToken?: string; refreshToken?: string; expiresAt?: string };
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    tokenData = JSON.parse(decrypted);
  } catch {
    return null;
  }

  // Get a valid access token (refresh if expired)
  // expiresAt is stored as epoch seconds (from OAuth connectors), convert to ms for comparison
  let accessToken = tokenData.accessToken;
  const expiresAt = tokenData.expiresAt ? Number(tokenData.expiresAt) * 1000 : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    if (!tokenData.refreshToken) return null;
    try {
      const { connector } = await resolveConnector({
        provider: connection.provider,
        oauthAppId: connection.oauthAppId,
        workspaceId: connection.workspaceId,
      });
      const newTokens = await connector.refresh(tokenData.refreshToken);
      accessToken = newTokens.accessToken;
    } catch {
      return null;
    }
  }

  try {
    const isGoogle = connection.provider === "google";
    const fetchUrl = isGoogle
      ? `https://people.googleapis.com/v1/${contactId}?personFields=names`
      : `https://graph.microsoft.com/v1.0/me/contacts/${contactId}?$select=displayName`;

    const res = await undiciRequest(fetchUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.statusCode !== 200) {
      // Drain body to avoid leaks
      await res.body.dump();
      return null;
    }

    const body = await res.body.json() as Record<string, unknown>;
    if (isGoogle) {
      // Google People API: { names: [{ displayName: "..." }] }
      const names = body.names as Array<{ displayName?: string }> | undefined;
      return names?.[0]?.displayName ?? null;
    } else {
      // Microsoft Graph: { displayName: "..." }
      return (body.displayName as string) ?? null;
    }
  } catch (err) {
    log.debug({ err, contactId }, "vault.fieldStepUp.nameResolveFailed");
    return null;
  }
}

/**
 * Best-effort resolve of attachment download context from the provider API.
 * Fetches the parent email's subject, sender, and attachment filename so the
 * approval card shows useful context instead of opaque IDs.
 * Returns null on any failure — callers fall back to no enrichment.
 */
async function resolveAttachmentMetadata(
  connection: { provider: string; encryptedTokens: string | null; oauthAppId: string | null; workspaceId: string },
  url: string,
  log: FastifyBaseLogger,
): Promise<AttachmentMetadata | null> {
  if (!connection.encryptedTokens) return null;

  let tokenData: { accessToken?: string; refreshToken?: string; expiresAt?: string };
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    tokenData = JSON.parse(decrypted);
  } catch {
    return null;
  }

  // Get a valid access token (refresh if expired)
  // expiresAt is stored as epoch seconds (from OAuth connectors), convert to ms for comparison
  let accessToken = tokenData.accessToken;
  const expiresAt = tokenData.expiresAt ? Number(tokenData.expiresAt) * 1000 : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    if (!tokenData.refreshToken) return null;
    try {
      const { connector } = await resolveConnector({
        provider: connection.provider,
        oauthAppId: connection.oauthAppId,
        workspaceId: connection.workspaceId,
      });
      const newTokens = await connector.refresh(tokenData.refreshToken);
      accessToken = newTokens.accessToken;
    } catch {
      return null;
    }
  }

  // Gmail attachment
  const gmailIds = extractGmailAttachmentIds(url);
  if (gmailIds) {
    return resolveGmailAttachmentMetadata(accessToken!, gmailIds.messageId, gmailIds.attachmentId, log);
  }

  // Outlook attachment
  const outlookIds = extractOutlookAttachmentIds(url);
  if (outlookIds) {
    return resolveOutlookAttachmentMetadata(accessToken!, outlookIds.messageId, outlookIds.attachmentId, log);
  }

  return null;
}

async function resolveEmailActionMetadata(
  connection: { provider: string; encryptedTokens: string | null; oauthAppId: string | null; workspaceId: string },
  url: string,
  method: string,
  log: FastifyBaseLogger,
): Promise<EmailActionMetadata | null> {
  if (!connection.encryptedTokens || connection.provider !== "google") return null;

  const gmailMessage = extractGmailMessageAction(url);
  if (!gmailMessage) return null;
  if (!(method === "DELETE" || gmailMessage.action === "trash" || gmailMessage.action === "untrash")) {
    return null;
  }

  let tokenData: { accessToken?: string; refreshToken?: string; expiresAt?: string };
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    tokenData = JSON.parse(decrypted);
  } catch (err) {
    log.warn({ err }, "vault.emailActionMetadata.skip.decrypt");
    return null;
  }

  let accessToken = tokenData.accessToken;
  // expiresAt is stored as epoch seconds (from OAuth connectors), convert to ms for comparison
  const expiresAt = tokenData.expiresAt ? Number(tokenData.expiresAt) * 1000 : 0;
  if (!accessToken || expiresAt < Date.now() + 60_000) {
    if (!tokenData.refreshToken) {
      return null;
    }
    try {
      const { connector } = await resolveConnector({
        provider: connection.provider,
        oauthAppId: connection.oauthAppId,
        workspaceId: connection.workspaceId,
      });
      const newTokens = await connector.refresh(tokenData.refreshToken);
      accessToken = newTokens.accessToken;
    } catch {
      return null;
    }
  }

  const result = await resolveGmailMessageMetadata(accessToken!, gmailMessage.messageId, log);
  return result;
}

async function handleModelB(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  ctx: {
    sub: string;
    connectionId: string;
    connection: {
      id: string;
      provider: string;
      service: string;
      encryptedTokens: string | null;
      metadata: unknown;
      oauthAppId: string | null;
      workspaceId: string;
    };
    policy: {
      id: string;
      agentId: string;
      allowlists: unknown;
      rateLimits: unknown;
      stepUpApproval: string;
      defaultMode: string;
      rules: unknown;
    };
    method: string;
    url: string;
    workspaceId: string;
    providerConstraints?: unknown;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    requestBody?: unknown;
    stream?: boolean;
    download?: boolean;
    approvalId?: string;
    bypassPiiRedaction?: boolean;
    sessionKey?: string;
    requestFullFields?: boolean;
    rawRequest?: FastifyRequest;
    transparentProxy?: boolean;
  },
) {
  const { sub, connectionId, connection, policy, method, query, headers, workspaceId, providerConstraints, approvalId, requestFullFields, sessionKey } = ctx;
  let { url } = ctx;
  const bypassPiiRedaction = ctx.bypassPiiRedaction === true;
  let requestBody = ctx.requestBody;

  // Email uses virtual URLs — agents send relative paths like "/messages?folder=INBOX"
  // which need a synthetic base for URL parsing and allowlist matching.
  if (connection.service === "email-imap" && !url.startsWith("http")) {
    url = `https://email-imap.internal${url.startsWith("/") ? "" : "/"}${url}`;
  }

  // Normalize string body to object — models sometimes pass JSON as a string
  // instead of a parsed object. Without this, chat ID extraction fails (returns null),
  // allowlist bypass doesn't trigger, and JSON.stringify double-encodes the body.
  if (typeof requestBody === "string") {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      // Not valid JSON — leave as string (text/plain will be set later)
    }
  }

  const originalRequestBody = ctx.requestBody;

  // Fingerprint the normalized request BEFORE any transformations (quarantine,
  // PII redaction, etc.) so approval redemption can verify the agent re-submitted
  // the exact same payload. Computed once, used at both creation and validation.
  const requestFingerprint = computeRequestFingerprint(requestBody, query, headers);

  if (sessionKey && requestBody && typeof requestBody === "object") {
    const quarantineRows = await db
      .select({ fragments: promptHistoryQuarantines.fragments })
      .from(promptHistoryQuarantines)
      .where(
        and(
          eq(promptHistoryQuarantines.workspaceId, workspaceId),
          eq(promptHistoryQuarantines.sessionKey, sessionKey),
        ),
      );
    const fragments = quarantineRows.flatMap((row) => Array.isArray(row.fragments) ? row.fragments as string[] : []);
    if (fragments.length > 0) {
      const sanitized = sanitizePromptHistoryForReplay(requestBody, fragments);
      if (sanitized.changed) {
        requestBody = sanitized.body;
        request.log.info(
          { sessionKey, quarantinedFragments: fragments.length, agentId: policy.agentId },
          "vault.modelB.promptHistoryQuarantined",
        );
      } else {
        request.log.info(
          {
            sessionKey,
            approvalId,
            quarantinedFragments: fragments.length,
            requestBodyKeys: Object.keys(requestBody as Record<string, unknown>),
            agentId: policy.agentId,
          },
          "vault.modelB.promptHistoryQuarantineNoop",
        );
      }
    }
  }

  // Check policy allowlists (default-deny)
  const allowlists = (policy.allowlists ?? []) as AllowlistEntry[];
  const allowlistCheck = checkAllowlists(allowlists, method, url);
  request.log.debug(
    { method, urlPath: new URL(url).pathname, allowed: allowlistCheck.allowed, ...(!allowlistCheck.allowed && { reason: allowlistCheck.reason }) },
    "vault.modelB.allowlist",
  );

  if (!allowlistCheck.allowed) {
    request.log.info(
      { method, urlPath: new URL(url).pathname, reason: allowlistCheck.reason, agentId: policy.agentId },
      "vault.modelB.denied.allowlist",
    );
    const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      url,
      reason: allowlistCheck.reason,
    });

    return reply.code(403).send({
      error: allowlistCheck.reason,
      ...("hint" in allowlistCheck && { hint: allowlistCheck.hint }),
      auditId,
    });
  }

  // SSRF protection: block requests to private/reserved IP ranges.
  // Skip for email-imap connections — they use virtual URLs (email-imap.internal)
  // and operate via IMAP/SMTP protocols, not HTTP.
  const parsedUrl = new URL(url);
  if (connection.service !== "email-imap") {
    const hostSafety = await checkHostSafety(parsedUrl.hostname);
    request.log.debug(
      { hostname: parsedUrl.hostname, safe: hostSafety.safe, ...(!hostSafety.safe && { resolvedIp: hostSafety.reason }) },
      "vault.modelB.ssrf",
    );
    if (!hostSafety.safe) {
      request.log.warn(
        { hostname: parsedUrl.hostname, reason: hostSafety.reason, agentId: policy.agentId },
        "vault.modelB.denied.ssrf",
      );
      const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
        model: "B",
        method,
        url,
        reason: hostSafety.reason,
      });

      return reply.code(403).send({ error: hostSafety.reason, auditId });
    }
  }

  // Telegram chat ID enforcement: only allow messages to allowlisted chats
  // Also tracks whether the chat is explicitly trusted (on the allowlist) so that
  // require_approval rules can be skipped for trusted recipients.
  let telegramChatOnAllowlist = false;
  let telegramTrustedResponseScope = false;
  if (connection.provider === "telegram" && isTelegramBotUrl(url)) {
    const chatId = extractTelegramChatId(requestBody);
    const pc = providerConstraints as { provider: string; allowedChatIds?: string[] } | null;
    const allowedChatIds = (pc?.provider === "telegram" ? pc.allowedChatIds : undefined) ?? [];

    // Empty allowedChatIds = no restriction (allow all chat IDs).
    // When specific IDs are listed, only those are allowed.
    const telegramChatAllowed = allowedChatIds.length === 0 || !chatId || allowedChatIds.includes(chatId);
    request.log.debug(
      { provider: "telegram", check: "chatId", chatId, allowed: telegramChatAllowed },
      "vault.modelB.chatIdCheck",
    );
    if (allowedChatIds.length > 0 && chatId) {
      if (!allowedChatIds.includes(chatId)) {
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Chat ID ${chatId} is not in the allowed chat list`,
          chatId,
        });

        return reply.code(403).send({
          error: `Chat ID ${chatId} is not in the allowed chat list`,
          auditId,
        });
      }
      // Chat is explicitly on the allowlist — trusted for approval bypass
      telegramChatOnAllowlist = true;
    }
    if (allowedChatIds.length > 0 && (telegramChatOnAllowlist || isTelegramGetUpdatesUrl(url))) {
      telegramTrustedResponseScope = true;
    }
  }

  // Microsoft Teams chat/channel enforcement: validate tenant ID and allowlisted chats/channels
  let teamsTrustedResponseScope = false;
  if (connection.service === "microsoft-teams" && isMicrosoftGraphUrl(url)) {
    const mspc = providerConstraints as { provider: string; allowedTenantIds?: string[]; allowedChatIds?: string[]; allowedChannelIds?: string[] } | null;
    const allowedTenantIds = (mspc?.provider === "microsoft" ? mspc.allowedTenantIds : undefined) ?? [];
    const allowedChatIds = (mspc?.provider === "microsoft" ? mspc.allowedChatIds : undefined) ?? [];
    const allowedChannelIds = (mspc?.provider === "microsoft" ? mspc.allowedChannelIds : undefined) ?? [];

    // Tenant ID enforcement if configured (tenantId is a connection identity property)
    const connMetadata = connection.metadata as Record<string, unknown> | null;
    if (allowedTenantIds.length > 0 && connMetadata?.["tenantId"]) {
      const connTenantId = String(connMetadata["tenantId"]);
      const tenantAllowed = allowedTenantIds.includes(connTenantId);
      request.log.debug(
        { provider: "microsoft", check: "tenantId", allowed: tenantAllowed },
        "vault.modelB.tenantIdCheck",
      );
      if (!allowedTenantIds.includes(connTenantId)) {
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Tenant ID ${connTenantId} is not in the allowed tenant list`,
        });

        return reply.code(403).send({
          error: `Tenant ID ${connTenantId} is not in the allowed tenant list`,
          auditId,
        });
      }
    }

    // Chat ID enforcement for chat endpoints
    const chatId = extractTeamsChatId(url);
    if (chatId && allowedChatIds.length > 0) {
      const teamsChatAllowed = allowedChatIds.includes(chatId);
      request.log.debug(
        { provider: "microsoft", check: "chatId", allowed: teamsChatAllowed },
        "vault.modelB.chatIdCheck",
      );
      if (!allowedChatIds.includes(chatId)) {
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Chat ID ${chatId} is not in the allowed chat list`,
          chatId,
        });

        return reply.code(403).send({
          error: `Chat ID ${chatId} is not in the allowed chat list`,
          auditId,
        });
      }
      teamsTrustedResponseScope = true;
    }

    // Channel ID enforcement for channel endpoints
    const channelInfo = extractTeamsChannelInfo(url);
    if (channelInfo && allowedChannelIds.length > 0) {
      const channelAllowed = allowedChannelIds.includes(channelInfo.channelId);
      request.log.debug(
        { provider: "microsoft", check: "channelId", allowed: channelAllowed },
        "vault.modelB.channelIdCheck",
      );
      if (!allowedChannelIds.includes(channelInfo.channelId)) {
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Channel ${channelInfo.channelId} is not in the allowed channel list`,
          channelId: channelInfo.channelId,
          teamId: channelInfo.teamId,
        });

        return reply.code(403).send({
          error: `Channel ${channelInfo.channelId} is not in the allowed channel list`,
          auditId,
        });
      }
      teamsTrustedResponseScope = true;
    }
  }

  // Slack channel enforcement: only allow messages to allowlisted channels.
  // DM channels (D... for 1:1, G... for group) are exempt — DM access is governed by allowedUserIds instead.
  let slackOnAllowlist = false;
  let slackTrustedResponseScope = false;
  if (connection.provider === "slack" && isSlackApiUrl(url)) {
    const pc = providerConstraints as { provider: string; allowedChannelIds?: string[]; allowedUserIds?: string[] } | null;
    const allowedChannelIds = (pc?.provider === "slack" ? pc.allowedChannelIds : undefined) ?? [];
    const allowedUserIds = (pc?.provider === "slack" ? pc.allowedUserIds : undefined) ?? [];

    // Channel enforcement: check "channel" or "channel_id" in request body
    const channel = extractSlackChannel(requestBody);
    if (allowedChannelIds.length > 0 && channel) {
      // DM channels (D... 1:1, G... group) bypass channel allowlist — access controlled by allowedUserIds
      const isDmChannel = channel.startsWith("D") || channel.startsWith("G");
      const channelAllowed = isDmChannel || allowedChannelIds.includes(channel);
      request.log.debug(
        { provider: "slack", check: "channelId", channel, allowed: channelAllowed, isDm: isDmChannel },
        "vault.modelB.slackChannelCheck",
      );
      if (!channelAllowed) {
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Channel ${channel} is not in the allowed channel list`,
        });

        return reply.code(403).send({
          error: `Channel ${channel} is not in the allowed channel list`,
          auditId,
        });
      }
      slackOnAllowlist = true;
      slackTrustedResponseScope = true;
    } else if (
      (isSlackConversationsListUrl(url) && (allowedChannelIds.length > 0 || allowedUserIds.length > 0)) ||
      (isSlackConversationsHistoryUrl(url) && allowedUserIds.length > 0)
    ) {
      // Slack list/history responses are filtered down to the trusted destination/user scope.
      slackTrustedResponseScope = true;
    }
  }

  // ── Policy rules engine (pre-execution) ──
  // Compile rules once (cached in-memory), evaluate before step-up approval.
  // If a rule matches, its action overrides the legacy stepUpApproval check.
  const rawRules = (policy.rules ?? { request: [], response: [] }) as PolicyRules;
  const compiledRules = getCompiledRules(policy.id, rawRules);
  let requestRuleResult: ReturnType<typeof evaluateRequestRules> = null;
  let ruleOverride: "allow" | "deny" | "require_approval" | "redact" | null = null;
  let ruleLabel: string | undefined;
  /** Set when a "redact" rule rewrites the request body. */
  let piiRedacted = false;
  let piiRedactions: RedactionInfo[] = [];
  let piiBypassRequested = false;
  let approvedReplayGranted = false;

  if (compiledRules.request.length > 0) {
    const parsedRequestUrl = new URL(url);
    const result = evaluateRequestRules(compiledRules.request, method, parsedRequestUrl.pathname, requestBody, parsedRequestUrl.search);
    requestRuleResult = result;

    request.log.debug(
      {
        matched: !!result,
        ...(result && { action: result.action, label: result.label, rulesChecked: result.rulesChecked, trace: result.trace }),
      },
      "vault.modelB.requestRules",
    );

    if (result) {
      if (result.action === "deny") {
        request.log.info(
          { method, urlPath: new URL(url).pathname, rule: result.label, agentId: policy.agentId },
          "vault.modelB.denied.rule",
        );
        const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          reason: `Denied by policy rule: "${result.label || "unnamed"}"`,
        });
        return reply.code(403).send({
          error: "Request denied by policy rule",
          ...(result.label && { hint: `Denied by rule: "${result.label}".` }),
          auditId,
        });
      }

      // "redact" action: replace request body with PII-redacted version unless
      // the caller is explicitly requesting a step-up to send the original.
      if (result.action === "redact" && result.redactedBody !== undefined) {
        piiRedactions = result.redactions ?? [];

        if (piiRedactions.length > 0 && bypassPiiRedaction) {
          piiBypassRequested = true;
          ruleOverride = "require_approval";
          requestBody = originalRequestBody;
        } else {
          requestBody = result.redactedBody;
          piiRedacted = true;
          ruleOverride = "redact";
          request.log.info(
            { redactions: piiRedactions.length, rule: result.label, agentId: policy.agentId },
            "vault.modelB.piiRedacted",
          );
        }
      } else {
        ruleOverride = result.action;
      }
      ruleLabel = result.label;
    }
  }

  // Step-up approval check for write actions
  // If a request rule returned "allow", skip step-up approval entirely.
  // If a request rule returned "require_approval", force it regardless of legacy config.
  // Microsoft Teams: 1:1 chats always require approval (risk_based), channels configurable
  let requiresApproval: boolean;
  if (ruleOverride === "allow" || ruleOverride === "redact") {
    // "redact" handled PII inline — no approval needed
    requiresApproval = false;
  } else if (ruleOverride === "require_approval") {
    if (piiBypassRequested) {
      requiresApproval = true;
    } else {
    // Telegram/Slack allowlist trust: if the target is on the policy's allowlist,
    // the user has explicitly trusted this recipient — skip approval.
    // Empty allowlist (no restrictions) still requires approval as normal.
      requiresApproval = !telegramChatOnAllowlist && !slackOnAllowlist;
    }
  } else {
    // Legacy fallback: no rule matched, use existing stepUpApproval logic
    requiresApproval = checkStepUpApproval(policy.stepUpApproval, method, connection.service, url);
    if (!requiresApproval && connection.service === "microsoft-teams" && policy.stepUpApproval === "risk_based") {
      if (isTeamsChatSendUrl(url) && method === "POST") {
        requiresApproval = true;
      }
    }
    // Trusted-recipient bypass: if the target chat/channel is on the policy allowlist,
    // skip approval regardless of which code path determined requiresApproval.
    if (requiresApproval && (telegramChatOnAllowlist || slackOnAllowlist)) {
      requiresApproval = false;
    }
  }
  request.log.info(
    {
      requiresApproval,
      reason: ruleOverride ? `rule:${ruleOverride}` : `legacy:${policy.stepUpApproval}`,
      ...(ruleLabel && { ruleLabel }),
    },
    "vault.modelB.approval",
  );

  // ── Field step-up approval ──
  // If the agent requests full PII fields on a balanced contacts policy,
  // force step-up approval so the workspace owner can grant access.
  // Only allowed on individual contact endpoints (not list/batch/search).
  let fieldStepUpGranted = false;
  let fieldStepUpContactId: string | undefined;
  if (requestFullFields) {
    const rawRules = policy.rules as { fieldStepUpEnabled?: boolean };
    if (!rawRules?.fieldStepUpEnabled) {
      return reply.code(403).send({
        error: "Full field access is not available for this policy tier",
        hint: "This policy does not support field step-up. Ask the workspace owner to switch to the balanced (standard) tier to enable it.",
      });
    }

    // Only allow on individual contact endpoints — not list/batch/search.
    // Approving full fields on a list endpoint would expose PII for all contacts at once.
    const parsed = parseIndividualContactUrl(url);
    if (!parsed) {
      return reply.code(403).send({
        error: "Full field access is only available for individual contact requests",
        hint: "Use requestFullFields on a single contact endpoint (e.g. GET /v1/people/{resourceName} or GET /v1.0/me/contacts/{id}), not on list, search, or batch endpoints. Fetch the contact list first, then request full fields for specific contacts.",
      });
    }
    fieldStepUpContactId = parsed.contactId;

    // Force approval — the approvalId bypass below will handle redemption
    requiresApproval = true;
    if (!approvalId) {
      ruleLabel = "Request full contact fields";
    }
  }

  // ── Approval ID bypass ──
  // If the agent provides an approvalId from a previously approved request,
  // verify it and skip the require_approval guard.
  if (approvalId) {
    const [existingApproval] = await db
      .select({
        status: approvalRequests.status,
        policyId: approvalRequests.policyId,
        connectionId: approvalRequests.connectionId,
        expiresAt: approvalRequests.expiresAt,
        requestDetails: approvalRequests.requestDetails,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.id, approvalId),
          eq(approvalRequests.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!existingApproval) {
      return reply.code(404).send({
        error: "Approval request not found",
        hint: "The approvalId does not match any approval request in this workspace.",
      });
    }

    if (existingApproval.status !== "approved") {
      return reply.code(409).send({
        error: `Approval request is ${existingApproval.status}, not approved`,
        hint: existingApproval.status === "pending"
          ? "This approval is still pending. Wait for the workspace owner to approve it."
          : `This approval has been ${existingApproval.status}. Submit a new request without approvalId.`,
      });
    }

    if (existingApproval.expiresAt <= new Date()) {
      return reply.code(410).send({
        error: "Approval request has expired",
        hint: "Submit a new request without approvalId to create a fresh approval.",
      });
    }

    // Verify the approval matches the current request (policy + connection + method + url + payload fingerprint)
    const details = existingApproval.requestDetails as {
      method: string;
      url: string;
      requestFingerprint?: string;
      bypassPiiRedaction?: boolean;
      requestFullFields?: boolean;
    };
    if (
      existingApproval.policyId !== policy.id ||
      existingApproval.connectionId !== connectionId ||
      details.method !== method ||
      details.url !== url
    ) {
      return reply.code(403).send({
        error: "Approval does not match this request",
        hint: "The approvalId was approved for a different request. Submit without approvalId to create a new approval.",
      });
    }

    // Verify the request payload (body + query + headers) hasn't been tampered with
    // since the approval was created. Approvals created before this check was added
    // won't have a fingerprint — skip validation for those (backwards-compatible).
    // Skip for LLM proxy requests (transparent proxy or session-based vault execute)
    // where the body legitimately changes between approval and replay because the
    // conversation progresses with new messages. LLM replay security is handled by
    // the prompt history quarantine system instead.
    const isLlmReplay = ctx.transparentProxy || Boolean(sessionKey);
    if (!isLlmReplay && details.requestFingerprint && details.requestFingerprint !== requestFingerprint) {
      return reply.code(403).send({
        error: "Request payload does not match the approved request",
        hint: "The request body, query parameters, or headers differ from the original approval request. Submit the identical request that was originally approved, or create a new approval without approvalId.",
      });
    }

    if (bypassPiiRedaction && details.bypassPiiRedaction !== true) {
      return reply.code(403).send({
        error: "Approval does not authorize PII bypass",
        hint: "Submit the request with bypassPiiRedaction: true to create a matching approval.",
      });
    }

    // Approval is valid — mark as consumed so it can't be reused
    request.log.info(
      { approvalId, agentId: policy.agentId, connectionId },
      "vault.modelB.approvalConsumed",
    );
    await db.update(approvalRequests)
      .set({ status: "consumed", updatedAt: new Date() })
      .where(eq(approvalRequests.id, approvalId))
      .catch((err) => {
        request.log.error(err, "Failed to mark approval as consumed");
        throw err;
      });
    // Scrub sensitive metadata now that the approval is consumed (fire-and-forget).
    // Preserve method, url, and requestFingerprint for audit trail.
    db.update(approvalRequests)
      .set({
        requestDetails: sql`jsonb_build_object(
          'method', ${approvalRequests.requestDetails}->'method',
          'url', ${approvalRequests.requestDetails}->'url',
          'requestFingerprint', ${approvalRequests.requestDetails}->'requestFingerprint'
        )`,
        updatedAt: new Date(),
      })
      .where(eq(approvalRequests.id, approvalId))
      .catch((err) => request.log.error(err, "Failed to scrub approval requestDetails"));

    // Skip the approval gate — fall through to execution
    requiresApproval = false;
    approvedReplayGranted = true;

    // If this approval was for full field access, relax PII-stripping response rules
    if (details.requestFullFields && requestFullFields) {
      fieldStepUpGranted = true;
      request.log.info({ approvalId }, "vault.modelB.fieldStepUpGranted");
    }
  }

  if (requiresApproval) {
    const approvalId = randomUUID();
    const quickActionToken = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS);

    const requestDetails: Record<string, unknown> = {
      method,
      url,
      requestFingerprint,
      ...(sessionKey && { sessionKey }),
      ...(bypassPiiRedaction && { bypassPiiRedaction: true }),
      ...(requestFullFields && { requestFullFields: true, contactId: fieldStepUpContactId }),
    };

    // Build guardTrigger for body-match rules (prompt injection, PII bypass)
    if (ruleLabel && requestBody && compiledRules.request.length > 0) {
      const guardTrigger = buildGuardTrigger(ruleLabel, requestRuleResult?.guardMatches, requestBody);
      if (guardTrigger) {
        requestDetails["guardTrigger"] = guardTrigger;
      }
    }

    // For Gmail send requests, parse MIME payload to extract email metadata
    if (isGmailSendUrl(url) && requestBody) {
      const emailMetadata = parseGmailSendPayload(requestBody);
      if (emailMetadata) {
        requestDetails["emailMetadata"] = emailMetadata;
      }
    }

    // For Telegram sendMessage requests, extract message metadata
    if (isTelegramBotUrl(url) && requestBody) {
      const telegramMetadata = parseTelegramSendPayload(requestBody);
      if (telegramMetadata) {
        requestDetails["telegramMetadata"] = telegramMetadata;
      }
    }

    // For Outlook Mail sendMail requests, extract email metadata
    if (isMicrosoftGraphUrl(url) && url.toLowerCase().includes("/sendmail") && requestBody) {
      const outlookEmail = parseOutlookSendMailPayload(requestBody);
      if (outlookEmail) {
        requestDetails["emailMetadata"] = outlookEmail;
      }
    }

    // For Microsoft Teams message sends, extract message metadata
    if (isMicrosoftGraphUrl(url) && requestBody) {
      const teamsMetadata = parseTeamsMessagePayload(requestBody);
      if (teamsMetadata) {
        // Enrich with chat/channel info from the URL
        const chatId = extractTeamsChatId(url);
        if (chatId) {
          teamsMetadata.chatId = chatId;
        }
        const channelInfo = extractTeamsChannelInfo(url);
        if (channelInfo) {
          teamsMetadata.channelId = channelInfo.channelId;
          teamsMetadata.teamId = channelInfo.teamId;
        }
        requestDetails["teamsMetadata"] = teamsMetadata;
      }
    }

    // For Slack chat.postMessage requests, extract message metadata
    if (isSlackApiUrl(url) && requestBody) {
      const slackMetadata = parseSlackSendPayload(requestBody);
      if (slackMetadata) {
        requestDetails["slackMetadata"] = slackMetadata;
      }
    }

    // For contact/calendar/drive writes, extract a brief summary for the approval card
    if (requestBody && typeof requestBody === "object") {
      const summary = extractGenericMetadata(url, method, requestBody as Record<string, unknown>);
      if (summary) {
        requestDetails["actionSummary"] = summary;
      }
    }

    // For email attachment downloads, resolve parent email context (best-effort)
    let attachmentMeta: AttachmentMetadata | null = null;
    if (isGmailAttachmentUrl(url) || isOutlookAttachmentUrl(url)) {
      attachmentMeta = await resolveAttachmentMetadata(connection, url, request.log);
      if (attachmentMeta) {
        requestDetails["attachmentMetadata"] = attachmentMeta;
      }
    }

    let emailActionMeta: EmailActionMetadata | null = null;
    const gmailAction = connection.provider === "google" ? extractGmailMessageAction(url) : null;
    if (gmailAction && (method === "DELETE" || gmailAction.action === "trash" || gmailAction.action === "untrash")) {
      emailActionMeta = await resolveEmailActionMetadata(connection, url, method, request.log);
      if (emailActionMeta) {
        requestDetails["emailActionMetadata"] = emailActionMeta;
      } else {
        // Fallback: store at least the message ID and action so the dashboard shows something useful
        requestDetails["emailActionMetadata"] = {
          messageId: gmailAction.messageId,
          messageSubject: "(could not fetch subject)",
          messageSender: "(could not fetch sender)",
        };
      }
    }

    // For field step-up, resolve the contact's display name from the provider API (best-effort)
    let contactDisplayName: string | undefined;
    if (requestFullFields && fieldStepUpContactId) {
      const name = await resolveContactDisplayName(connection, fieldStepUpContactId, request.log);
      if (name) {
        contactDisplayName = name;
        requestDetails["contactDisplayName"] = name;
      }
    }

    const gmailActionLabel = gmailAction
      ? `${gmailAction.action === "trash" ? "Trash" : gmailAction.action === "untrash" ? "Untrash" : "Delete"} email`
      : null;
    const approvalReason = requestFullFields
      ? `Agent requested full contact details for ${contactDisplayName ?? fieldStepUpContactId ?? "a contact"} (phone numbers, addresses, birthdays)`
      : attachmentMeta
        ? `Attachment download from ${attachmentMeta.messageSender} — "${attachmentMeta.messageSubject}"${attachmentMeta.attachmentName ? ` (${attachmentMeta.attachmentName})` : ""}`
        : emailActionMeta
          ? `${gmailActionLabel ?? "Modify"} email from ${emailActionMeta.messageSender} — "${emailActionMeta.messageSubject}"`
          : gmailActionLabel
            ? `${gmailActionLabel} (message ID: ${gmailAction!.messageId})`
        : ruleLabel
          ? `Guard: ${ruleLabel}`
          : `${method === "DELETE" ? "Delete" : "Write"} operation requires approval`;

    await db.insert(approvalRequests).values({
      id: approvalId,
      policyId: policy.id,
      agentId: policy.agentId,
      connectionId,
      workspaceId,
      actor: sub,
      status: "pending",
      requestDetails,
      reason: approvalReason,
      quickActionToken,
      expiresAt,
    });

    await seedPromptHistoryQuarantine({
      approvalId,
      workspaceId,
      requestDetails,
    });

    request.log.info(
      { approvalId, agentId: policy.agentId, connectionId, method, urlPath: new URL(url).pathname, reason: approvalReason },
      "vault.modelB.approvalCreated",
    );
    const { auditId } = logApprovalRequested(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      url,
      approvalRequestId: approvalId,
    });

    // Fire-and-forget: look up agent name and notify workspace owner
    db.select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, policy.agentId))
      .limit(1)
      .then(([agent]) => {
        const agentName = agent?.name ?? "An agent";
        createNotification({
          workspaceId,
          type: "approval_request",
          title: `${agentName} needs approval`,
          body: ruleLabel
            ? `${agentName} triggered "${ruleLabel}" — ${method} ${url}`
            : `${agentName} wants to ${method} ${url}`,
          linkUrl: "/dashboard/approvals",
          metadata: { agentId: policy.agentId, connectionId, approvalRequestId: approvalId, method, url },
        });
        // Send to external channels (Telegram, etc.)
        sendApprovalNotifications({
          workspaceId,
          approvalId,
          agentName,
          method,
          url,
          quickActionToken,
          expiresAt,
          ruleLabel,
        });
      })
      .catch((err) => { request.log.error({ err, approvalId }, "Failed to create approval notification"); });

    // Build context-aware hint
    const isDownloadRule = ruleLabel?.toLowerCase().includes("download");
    let approvalHint: string;
    if (isDownloadRule) {
      const isGoogle = connection.provider === "google";
      const urlLower = url.toLowerCase();
      const isExcel = /\.(xlsx|xls|csv)([:/]|$)/.test(urlLower);
      const isConvertible = /\.(docx?|xlsx?|pptx?|pdf|csv)([:/]|$)/.test(urlLower);
      approvalHint = "This binary file download requires approval because response content filtering cannot be applied to raw binary data. "
        + "Options: (1) Ask the user to approve in the dashboard, then re-submit with approvalId. "
        + (isGoogle
          ? isConvertible
            ? "(2) For convertible files (documents, spreadsheets, PDFs), use copy-convert (POST /files/{id}/copy with a Google-native mimeType) and read via structured API instead."
            : ""
          : isExcel
            ? "(2) For Excel files, use the Workbook API (GET /me/drive/items/{id}/workbook/worksheets/{name}/usedRange) to read content as structured JSON instead."
            : "");
    } else if (requestFullFields) {
      approvalHint = "Full contact field access requires approval. Once approved, re-submit the same request with approvalId set to this approvalRequestId and requestFullFields: true. Phone numbers, addresses, and birthdays will be visible; notes remain stripped.";
    } else if (bypassPiiRedaction) {
      approvalHint = "This request contains redacted PII. Once approved, re-submit the same request with approvalId set to this approvalRequestId and bypassPiiRedaction: true to send the original content.";
    } else {
      approvalHint = "This request requires approval. Once approved, re-submit the same request with approvalId set to this approvalRequestId.";
    }

    if (ctx.transparentProxy) {
      if (ctx.stream) {
        sendTransparentApprovalStream(
          reply,
          connection.provider,
          new URL(url).pathname,
          approvalId,
          approvalReason,
          approvalHint,
        );
        return;
      }
      return sendTransparentApprovalResponse(
        reply,
        connection.provider,
        new URL(url).pathname,
        approvalId,
        approvalReason,
        approvalHint,
      );
    }

    return reply.code(202).send({
      approvalRequired: true,
      approvalRequestId: approvalId,
      reason: approvalReason,
      expiresAt: expiresAt.toISOString(),
      hint: approvalHint,
      ...(ruleLabel && { ruleLabel }),
      auditId,
    });
  }

  // If field step-up was granted, remove PII-stripping and PII-redaction response rules.
  // The user explicitly approved full contact access — partial redaction of phone numbers
  // by cs-pii-redact would defeat the purpose. Notes stripping (dr-contact-notes) remains.
  let effectiveRules = compiledRules;
  if (fieldStepUpGranted && compiledRules.response.length > 0) {
    const FIELD_STEP_UP_REMOVE_LABELS = new Set([
      "Strip contact PII fields",           // dr-contact-pii
      "Redact PII from all responses",      // cs-pii-redact
    ]);
    const relaxedResponse = compiledRules.response.filter(
      (r) => !FIELD_STEP_UP_REMOVE_LABELS.has(r.label),
    );
    effectiveRules = { ...compiledRules, response: relaxedResponse };
  }
  if (
    effectiveRules.response.length > 0 &&
    (telegramTrustedResponseScope || slackTrustedResponseScope || teamsTrustedResponseScope)
  ) {
    effectiveRules = stripTrustedRecipientPiiRedaction(effectiveRules);
  }

  if (approvedReplayGranted && requestBody && typeof requestBody === "object") {
    const replayContext = injectReplayApprovalContext(requestBody, connection.provider, new URL(url).pathname);
    if (replayContext.changed) {
      requestBody = replayContext.body;
      request.log.info(
        { approvalId, provider: connection.provider, urlPath: new URL(url).pathname, agentId: policy.agentId },
        "vault.modelB.replayApprovalContextInjected",
      );
    }
  }

  const execCtx: Parameters<typeof executeModelBRequest>[2] = {
    sub,
    connectionId,
    connection,
    policy: { agentId: policy.agentId, rateLimits: policy.rateLimits },
    policyId: policy.id,
    workspaceId,
    method,
    url,
    compiledRules: effectiveRules.response.length > 0 ? effectiveRules : undefined,
    requestLog: request.log,
  };
  if (query !== undefined) execCtx.query = query;
  if (headers !== undefined) execCtx.headers = headers;
  if (requestBody !== undefined) execCtx.requestBody = requestBody;
  if (ctx.stream) execCtx.stream = ctx.stream;
  if (ctx.download) execCtx.download = ctx.download;
  if (ctx.rawRequest) execCtx.rawRequest = ctx.rawRequest;
  if (providerConstraints !== undefined) execCtx.providerConstraints = providerConstraints;
  if (ctx.transparentProxy) execCtx.transparentProxy = ctx.transparentProxy;
  if (piiRedacted) {
    execCtx.piiRedacted = true;
    execCtx.piiRedactions = piiRedactions;
  }

  return executeModelBRequest(fastify, reply, execCtx);
}

// ────────────────────── Model B Execution (reusable) ──────────────────────

export interface ModelBExecutionContext {
  sub: string;
  connectionId: string;
  connection: {
    id: string;
    provider: string;
    service: string;
    encryptedTokens: string | null;
    oauthAppId: string | null;
    workspaceId: string;
  };
  policy: {
    agentId: string;
    rateLimits: unknown;
  };
  method: string;
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  requestBody?: unknown;
  compiledRules?: CompiledPolicyRules | undefined;
  /** When true, stream the provider response directly (SSE, NDJSON, etc.) instead of JSON envelope */
  stream?: boolean;
  /** When true, return the raw binary response instead of wrapping in a JSON envelope */
  download?: boolean;
  /** Raw Fastify request — needed for AbortSignal on client disconnect during streaming */
  rawRequest?: FastifyRequest;
  /** Request-scoped logger for debug tracing (carries reqId for correlation) */
  requestLog?: FastifyBaseLogger;
  /** Policy ID — needed for rate-limit budget approval creation */
  policyId?: string;
  /** Workspace ID — needed for rate-limit budget approval creation */
  workspaceId?: string;
  /** Provider-specific constraints (e.g., Telegram allowedChatIds) for inbound filtering */
  providerConstraints?: unknown;
  /** When true, forward provider error responses raw (status + body) instead of vault envelope.
   *  Used by /vault/llm/ transparent proxy so SDKs see native provider errors. */
  transparentProxy?: boolean;
  /** Set when a "redact" rule rewrote the request body before forwarding. */
  piiRedacted?: boolean;
  /** Metadata about what PII was redacted. */
  piiRedactions?: RedactionInfo[];
}

/**
 * Execute a Model B request — handles rate limits, payload validation,
 * token decryption, HTTP execution, and audit logging.
 * Used by both direct Model B flow and approved step-up requests.
 */
export async function executeModelBRequest(
  fastify: FastifyInstance,
  reply: FastifyReply,
  ctx: ModelBExecutionContext,
) {
  const { sub, connectionId, connection, policy, method, url, query, headers, requestBody, providerConstraints } = ctx;
  const log = ctx.requestLog;

  // Check rate limits for Model B
  const rateLimits = policy.rateLimits as {
    maxRequestsPerHour?: number;
    maxPayloadSizeBytes?: number;
    maxResponseSizeBytes?: number;
  } | null;

  if (rateLimits?.maxRequestsPerHour) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [result] = await db
      .select({ total: count() })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.agentId, policy.agentId),
          eq(auditEvents.connectionId, connectionId),
          eq(auditEvents.action, "execution_completed"),
          gte(auditEvents.timestamp, oneHourAgo),
        ),
      );

    const currentCount = result?.total ?? 0;
    const rateLimitAllowed = currentCount < rateLimits.maxRequestsPerHour;
    if (!rateLimitAllowed) {
      log?.info(
        { limit: rateLimits.maxRequestsPerHour, currentCount, agentId: policy.agentId, connectionId, provider: connection.provider },
        "vault.exec.rateLimitExceeded",
      );
    }

    if (!rateLimitAllowed) {
      // LLM providers: trigger a one-time budget approval instead of hard 429.
      // The approval acts as a standing override for the current hour.
      const isLlm = LLM_PROVIDERS[connection.provider] !== undefined;

      if (isLlm && ctx.policyId && ctx.workspaceId) {
        // Check for existing approved (not expired) rate-limit override
        const [override] = await db
          .select({ id: approvalRequests.id, expiresAt: approvalRequests.expiresAt })
          .from(approvalRequests)
          .where(
            and(
              eq(approvalRequests.policyId, ctx.policyId),
              eq(approvalRequests.connectionId, connectionId),
              eq(approvalRequests.workspaceId, ctx.workspaceId),
              eq(approvalRequests.status, "approved"),
              gte(approvalRequests.expiresAt, new Date()),
              sql`${approvalRequests.requestDetails}->>'type' = 'rate_limit_override'`,
            ),
          )
          .limit(1);

        if (override) {
          // Standing budget override exists — skip rate limit
          log?.debug(
            { overrideId: override.id, expiresAt: override.expiresAt },
            "vault.exec.rateLimitOverride.found",
          );
          // Fall through to execution
        } else {
          // Check for pending override (avoid duplicates)
          const [pending] = await db
            .select({ id: approvalRequests.id, expiresAt: approvalRequests.expiresAt, reason: approvalRequests.reason })
            .from(approvalRequests)
            .where(
              and(
                eq(approvalRequests.policyId, ctx.policyId),
                eq(approvalRequests.connectionId, connectionId),
                eq(approvalRequests.workspaceId, ctx.workspaceId),
                eq(approvalRequests.status, "pending"),
                gte(approvalRequests.expiresAt, new Date()),
                sql`${approvalRequests.requestDetails}->>'type' = 'rate_limit_override'`,
              ),
            )
            .limit(1);

          if (pending) {
            return reply.code(202).send({
              approvalRequired: true,
              approvalRequestId: pending.id,
              reason: pending.reason,
              expiresAt: pending.expiresAt.toISOString(),
              hint: "Rate limit budget exceeded. A budget override request is already pending. Once approved, you can continue making requests.",
            });
          }

          // Create new rate-limit override approval
          const overrideId = randomUUID();
          const quickActionToken = randomBytes(32).toString("hex");
          const overrideExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
          const overrideReason = `Rate limit exceeded (${currentCount}/${rateLimits.maxRequestsPerHour} per hour)`;

          await db.insert(approvalRequests).values({
            id: overrideId,
            policyId: ctx.policyId,
            agentId: policy.agentId,
            connectionId,
            workspaceId: ctx.workspaceId,
            actor: sub,
            status: "pending",
            requestDetails: {
              type: "rate_limit_override",
              method,
              url,
              limit: rateLimits.maxRequestsPerHour,
              currentCount,
              ...(requestBody && typeof requestBody === "object" && typeof (requestBody as Record<string, unknown>).model === "string"
                ? { modelName: (requestBody as Record<string, unknown>).model }
                : {}),
            },
            reason: overrideReason,
            quickActionToken,
            expiresAt: overrideExpiresAt,
          });

          const { auditId } = logRateLimitExceeded(sub, policy.agentId, connectionId, {
            model: "B",
            method,
            url,
            limit: rateLimits.maxRequestsPerHour,
            currentCount,
          });

          // Fire-and-forget notification
          db.select({ name: agents.name })
            .from(agents)
            .where(eq(agents.id, policy.agentId))
            .limit(1)
            .then(([agent]) => {
              const agentName = agent?.name ?? "An agent";
              createNotification({
                workspaceId: ctx.workspaceId!,
                type: "approval_request",
                title: `${agentName} needs budget override`,
                body: `${agentName} exceeded the rate limit (${rateLimits.maxRequestsPerHour}/hr). Approve to allow continued access for 1 hour.`,
                linkUrl: "/dashboard/approvals",
                metadata: { agentId: policy.agentId, connectionId, approvalRequestId: overrideId },
              });
              sendApprovalNotifications({
                workspaceId: ctx.workspaceId!,
                approvalId: overrideId,
                agentName,
                method,
                url: `Budget override: ${rateLimits.maxRequestsPerHour}/hr limit reached`,
                quickActionToken,
                expiresAt: overrideExpiresAt,
              });
            })
            .catch((err) => { (log ?? fastify.log).error({ err, approvalId: overrideId }, "Failed to create budget override notification"); });

          return reply.code(202).send({
            approvalRequired: true,
            approvalRequestId: overrideId,
            reason: overrideReason,
            expiresAt: overrideExpiresAt.toISOString(),
            hint: `Rate limited at ${rateLimits.maxRequestsPerHour} requests/hour. Approve this budget override to allow continued access for 1 hour.`,
            auditId,
          });
        }
      } else {
        // Non-LLM provider: hard 429
        const [oldest] = await db
          .select({ ts: auditEvents.timestamp })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.agentId, policy.agentId),
              eq(auditEvents.connectionId, connectionId),
              eq(auditEvents.action, "execution_completed"),
              gte(auditEvents.timestamp, oneHourAgo),
            ),
          )
          .orderBy(auditEvents.timestamp)
          .limit(1);

        const retryAfter = oldest
          ? Math.max(1, Math.ceil((oldest.ts.getTime() + 3600_000 - Date.now()) / 1000))
          : 3600;

        const { auditId } = logRateLimitExceeded(sub, policy.agentId, connectionId, {
          model: "B",
          method,
          url,
          limit: rateLimits.maxRequestsPerHour,
          currentCount,
        });

        reply.header("Retry-After", String(retryAfter));
        return reply.code(429).send({
          error: `Rate limit exceeded: ${rateLimits.maxRequestsPerHour} requests per hour`,
          hint: `Rate limited at ${rateLimits.maxRequestsPerHour} requests/hour. Retry after ${retryAfter} seconds.`,
          retryAfter,
          auditId,
        });
      }
    }
  }

  // Check payload size limit (use policy limit or default 10MB)
  const maxPayloadSize = rateLimits?.maxPayloadSizeBytes ?? DEFAULT_MAX_PAYLOAD_SIZE_BYTES;
  if (requestBody !== undefined) {
    const bodyStr = typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody);
    const actualSize = Buffer.byteLength(bodyStr, "utf8");
    const payloadAllowed = actualSize <= maxPayloadSize;
    log?.debug(
      { maxPayloadSize, actualSize, allowed: payloadAllowed },
      "vault.exec.payloadSize",
    );
    if (!payloadAllowed) {
      const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
        model: "B",
        method,
        url,
        reason: "Payload size exceeds limit",
        limit: maxPayloadSize,
      });

      return reply.code(413).send({
        error: `Payload size exceeds limit of ${maxPayloadSize} bytes`,
        hint: `Your payload is ${actualSize} bytes. Maximum allowed is ${maxPayloadSize} bytes (${Math.round(maxPayloadSize / 1024 / 1024)}MB).`,
        auditId,
      });
    }
  }

  // Decrypt stored tokens to get access token (null means tokens were zeroed on revoke)
  if (!connection.encryptedTokens) {
    return reply.code(409).send({ error: "Connection tokens have been revoked" });
  }

  let tokenData: {
    accessToken?: string;
    refreshToken?: string;
    tokenType?: string;
    expiresAt?: string;
    botToken?: string;
    apiKey?: string;
    appKey?: string;
    email?: string;
    siteUrl?: string;
  };
  try {
    const encryptedPayload: EncryptedPayload = JSON.parse(connection.encryptedTokens);
    const decrypted = decrypt(encryptedPayload, getEncryptionKey());
    tokenData = JSON.parse(decrypted);
  } catch (err) {
    return reply500(reply, err, "Failed to decrypt connection tokens", { extra: { connectionId } });
  }

  log?.info(
    {
      provider: connection.provider,
      tokenType: tokenData.botToken ? "bot" : tokenData.apiKey ? "api-key" : "oauth",
      hasRefreshToken: !!tokenData.refreshToken,
      hasAccessToken: !!tokenData.accessToken,
      expiresAt: tokenData.expiresAt,
    },
    "vault.exec.credential",
  );

  // Email uses IMAP/SMTP protocols, not HTTP. Delegate to the email provider handler
  // before entering the HTTP proxy flow (SSRF check, fetch, etc.).
  if (connection.provider === "email") {
    const emailCreds = tokenData as unknown as EmailCredentials;
    if (!emailCreds.imap || !emailCreds.smtp) {
      return reply.code(500).send({ error: "Email credentials incomplete" });
    }
    const result = await handleEmailRequest(method, url, requestBody, emailCreds, connectionId, log ?? fastify.log, { download: !!ctx.download });

    // When download: true and the result has base64 content (attachment), decode
    // and stream raw binary so vault_download saves a usable file.
    const emailBody = result.body as Record<string, unknown> | undefined;
    if (ctx.download && result.status >= 200 && result.status < 300 && emailBody?.content && typeof emailBody.content === "string") {
      reply.hijack();
      const decoded = Buffer.from(emailBody.content as string, "base64");
      const ct = (typeof emailBody.contentType === "string" ? emailBody.contentType : "application/octet-stream");
      const filename = typeof emailBody.filename === "string" ? emailBody.filename : null;
      const headers: Record<string, string> = {
        "Content-Type": ct,
        "Content-Length": String(decoded.length),
        "Cache-Control": "no-cache",
      };
      if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
      reply.raw.writeHead(200, headers);
      reply.raw.end(decoded);
      logExecutionCompleted(sub, policy.agentId, connectionId, {
        model: "B", method, path: new URL(url).pathname,
        responseStatus: result.status, dataSize: decoded.length, provider: connection.provider,
      });
      return;
    }

    const responseJson = JSON.stringify(result.body);
    const { auditId } = logExecutionCompleted(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      path: new URL(url).pathname,
      responseStatus: result.status,
      dataSize: Buffer.byteLength(responseJson, "utf8"),
      provider: connection.provider,
    });
    // Wrap in the standard vault execute response format so agents see
    // { model, status, headers, body, auditId } consistently.
    const httpStatus = result.status >= 200 && result.status < 300 ? 200 : result.status;
    return reply.code(httpStatus).send({
      model: "B",
      status: result.status,
      headers: { "content-type": "application/json" },
      body: result.body,
      auditId,
    });
  }

  // Get the access token — for Telegram, use bot token; for API key providers, use API key; for OAuth, refresh first
  let accessToken: string;

  if (connection.provider === "telegram" || connection.provider === "slack") {
    if (!tokenData.botToken) {
      return reply500(reply, new Error(`${connection.provider} bot token not found in stored tokens`), `${connection.provider} bot token not found in stored tokens`, { extra: { connectionId } });
    }
    accessToken = tokenData.botToken;
  } else if (connection.provider === "anthropic" && tokenData.refreshToken) {
    // Anthropic OAuth (sk-ant-oat-*) — refresh if expired or expiring within 60s
    let currentToken = tokenData.apiKey ?? tokenData.accessToken;
    // expiresAt is stored as epoch seconds (from OAuth connectors), convert to ms for comparison
    const expiresAt = tokenData.expiresAt ? Number(tokenData.expiresAt) * 1000 : 0;

    if (!currentToken || expiresAt < Date.now() + 60_000) {
      log?.debug({ provider: "anthropic" }, "vault.exec.tokenRefresh.start");
      try {
        (log ?? fastify.log).info({ connectionId, provider: "anthropic" }, "Refreshing Anthropic OAuth token");
        const newTokens = await refreshAnthropicToken(tokenData.refreshToken);
        currentToken = newTokens.accessToken;
        log?.debug({ provider: "anthropic", refreshed: true }, "vault.exec.tokenRefresh.result");

        // Persist refreshed tokens (fire-and-forget)
        const updatedPayload = JSON.stringify({
          accessToken: newTokens.accessToken,
          refreshToken: newTokens.refreshToken,
          expiresAt: newTokens.expiresAt,
        });
        const { encrypt } = await import("@agenthifive/security");
        const encrypted = JSON.stringify(encrypt(updatedPayload, getEncryptionKey()));
        db.update(connections)
          .set({ encryptedTokens: encrypted, updatedAt: new Date() })
          .where(eq(connections.id, connectionId))
          .then(() => {})
          .catch((err) => (log ?? fastify.log).error(err, "Failed to persist refreshed Anthropic tokens"));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Anthropic token refresh failed";
        (log ?? fastify.log).warn({ err, connectionId }, "Anthropic OAuth refresh failed");
        log?.debug({ provider: "anthropic", refreshed: false }, "vault.exec.tokenRefresh.result");
        await markConnectionNeedsReauth(connectionId, message, log ?? fastify.log);
        return reply.code(409).send({ error: "Anthropic connection requires reauthentication" });
      }
    }

    if (!currentToken) {
      return reply500(reply, new Error("Anthropic token not found in stored tokens"), "Anthropic token not found in stored tokens", { extra: { connectionId } });
    }
    accessToken = currentToken;
  } else if (connection.provider === "anthropic" || connection.provider === "openai" || connection.provider === "gemini" || connection.provider === "openrouter" || connection.provider === "notion" || connection.provider === "trello" || connection.provider === "jira") {
    if (!tokenData.apiKey) {
      return reply500(reply, new Error(`${connection.provider} API key not found in stored tokens`), `${connection.provider} API key not found in stored tokens`, { extra: { connectionId } });
    }
    accessToken = tokenData.apiKey;
  } else {
    // OAuth providers — refresh token to get fresh access token
    if (!tokenData.refreshToken) {
      await markConnectionNeedsReauth(
        connectionId,
        "No refresh token available",
        log ?? fastify.log,
      );
      return reply.code(409).send({ error: "Connection requires reauthentication (no refresh token)" });
    }

    log?.info({ provider: connection.provider }, "vault.exec.tokenRefresh.start");
    let newTokenSet;
    try {
      const { connector } = await resolveConnector({
        provider: connection.provider,
        oauthAppId: connection.oauthAppId,
        workspaceId: connection.workspaceId,
      });
      newTokenSet = await connector.refresh(tokenData.refreshToken);
      log?.info({ provider: connection.provider, refreshed: true, scopes: newTokenSet.scope, expiresAt: newTokenSet.expiresAt }, "vault.exec.tokenRefresh.result");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Token refresh failed";
      (log ?? fastify.log).warn({ err, connectionId }, "Token refresh failed");
      log?.debug({ provider: connection.provider, refreshed: false }, "vault.exec.tokenRefresh.result");

      await markConnectionNeedsReauth(
        connectionId,
        message,
        log ?? fastify.log,
      );

      return reply.code(409).send({ error: "Connection requires reauthentication" });
    }

    accessToken = newTokenSet.accessToken;

    // Re-encrypt and update stored tokens (fire-and-forget)
    const updatedTokenPayload = JSON.stringify({
      accessToken: newTokenSet.accessToken,
      refreshToken: newTokenSet.refreshToken ?? tokenData.refreshToken,
      tokenType: newTokenSet.tokenType,
      expiresAt: newTokenSet.expiresAt,
    });

    const { encrypt } = await import("@agenthifive/security");
    const encryptedTokens = JSON.stringify(encrypt(updatedTokenPayload, getEncryptionKey()));

    db.update(connections)
      .set({
        encryptedTokens,
        updatedAt: new Date(),
      })
      .where(eq(connections.id, connectionId))
      .then(() => {})
      .catch((err) => (log ?? fastify.log).error(err, "Failed to update connection tokens after refresh"));
  }

  // Build the target URL with query params
  let finalUrl = url;

  // For Telegram, inject bot token into URL path instead of using Authorization header.
  // The agent sends URLs like https://api.telegram.org/bot/sendMessage (no token),
  // and the proxy rewrites to https://api.telegram.org/bot<TOKEN>/sendMessage.
  const isTelegram = connection.provider === "telegram";
  if (isTelegram) {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      // Replace /bot/ or /bot<placeholder>/ with /bot<actualToken>/
      const pathMatch = parsed.pathname.match(/^\/bot[^/]*\/(.+)$/);
      if (pathMatch) {
        parsed.pathname = `/bot${accessToken}/${pathMatch[1]}`;
      } else {
        (log ?? fastify.log).warn({ pathname: parsed.pathname }, "Telegram URL path did not match /bot*/ pattern — token not injected");
      }
      finalUrl = parsed.toString();
    } else {
      (log ?? fastify.log).warn({ hostname: parsed.hostname }, "Telegram request to unexpected hostname — expected api.telegram.org");
    }
  }

  // For Trello, inject API key and user token as query params.
  // The agent sends URLs like https://api.trello.com/1/members/me/boards (no credentials),
  // and the proxy appends ?key=<APP_KEY>&token=<USER_TOKEN>.
  // Both values are stored per-connection in encrypted tokens (appKey + apiKey).
  const isTrello = connection.provider === "trello";
  if (isTrello) {
    const trelloAppKey = tokenData.appKey;
    if (!trelloAppKey) {
      return reply500(reply, new Error("Trello Power-Up API key not found"), "Trello Power-Up API key not found in stored connection. Reconnect with both API key and user token.", { extra: { connectionId } });
    }
    const parsed = new URL(finalUrl);
    parsed.searchParams.set("key", trelloAppKey);
    parsed.searchParams.set("token", accessToken);
    finalUrl = parsed.toString();
  }

  // For Jira Cloud, validate the request URL hostname matches the connection's stored siteUrl,
  // then build Basic auth header from email + apiToken. The base URL is variable per connection.
  const isJira = connection.provider === "jira";
  let jiraBasicAuth: string | undefined;
  if (isJira) {
    const jiraEmail = tokenData.email;
    const jiraSiteUrl = tokenData.siteUrl;
    if (!jiraEmail || !jiraSiteUrl) {
      return reply500(reply, new Error("Jira email or site URL not found"), "Jira email or site URL not found in stored credentials. Reconnect with all three fields.", { extra: { connectionId } });
    }
    const parsed = new URL(finalUrl);
    if (parsed.hostname !== jiraSiteUrl) {
      return reply.code(403).send({
        error: `URL hostname mismatch: expected ${jiraSiteUrl}`,
        hint: `Send requests to https://${jiraSiteUrl}/rest/api/3/...`,
      });
    }
    jiraBasicAuth = Buffer.from(`${jiraEmail}:${accessToken}`).toString("base64");
  }

  const targetUrl = new URL(finalUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      targetUrl.searchParams.set(key, value);
    }
  }

  // Sanitize user-provided headers and add auth credentials
  const sanitizedHeaders = sanitizeHeaders(headers);

  if (!isTelegram && !isTrello && !isJira) {
    // Inject provider auth headers (Telegram uses token-in-URL, Trello uses query params, Jira uses Basic auth — all handled separately)
    // Lowercase keys to match sanitizeHeaders() convention — prevents duplicate headers
    // when the agent also sends the same header (e.g., Notion-Version, anthropic-version).
    const authHeaders = buildProviderAuthHeaders(connection.provider, accessToken);
    for (const [key, value] of Object.entries(authHeaders)) {
      const lower = key.toLowerCase();
      // Merge anthropic-beta values (union of SDK betas + auth betas) instead
      // of overwriting — the SDK sends functional betas (fine-grained-tool-streaming)
      // while buildProviderAuthHeaders adds OAuth-required betas.
      if (lower === "anthropic-beta" && sanitizedHeaders["anthropic-beta"]) {
        const existing = new Set(sanitizedHeaders["anthropic-beta"].split(",").map((b) => b.trim()).filter(Boolean));
        for (const b of value.split(",").map((b) => b.trim()).filter(Boolean)) {
          existing.add(b);
        }
        sanitizedHeaders["anthropic-beta"] = [...existing].join(",");
      } else {
        sanitizedHeaders[lower] = value;
      }
    }

    // For Anthropic API key auth: the SDK may send OAuth-specific betas because
    // the vault JWT triggers isOAuthToken() in pi-ai. Strip OAuth-specific betas
    // but keep functional ones (fine-grained-tool-streaming, interleaved-thinking, etc.)
    // so future SDK beta additions flow through automatically.
    if (connection.provider === "anthropic" && !accessToken.startsWith("sk-ant-oat") && sanitizedHeaders["anthropic-beta"]) {
      const OAUTH_ONLY_BETAS = new Set(["claude-code-20250219", "oauth-2025-04-20"]);
      const betas = sanitizedHeaders["anthropic-beta"]
        .split(",")
        .map((b) => b.trim())
        .filter((b) => b && !OAUTH_ONLY_BETAS.has(b));
      sanitizedHeaders["anthropic-beta"] = betas.length > 0 ? betas.join(",") : "";
      if (!sanitizedHeaders["anthropic-beta"]) {
        delete sanitizedHeaders["anthropic-beta"];
      }
    }
  }

  // Jira: inject Basic auth header
  if (isJira && jiraBasicAuth) {
    sanitizedHeaders["authorization"] = `Basic ${jiraBasicAuth}`;
    if (!sanitizedHeaders["accept"]) {
      sanitizedHeaders["accept"] = "application/json";
    }
  }

  // Anthropic OAuth tokens (sk-ant-oat-*) require the Claude Code identity
  // system prompt in the request body. When the SDK talks to the vault (JWT),
  // it doesn't detect OAuth and omits this prompt. We inject it server-side
  // so the upstream Anthropic API accepts the request.
  if (
    connection.provider === "anthropic" &&
    accessToken.startsWith("sk-ant-oat") &&
    requestBody &&
    typeof requestBody === "object"
  ) {
    const body = requestBody as Record<string, unknown>;
    const ccIdentity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
    const existing = body.system;
    if (Array.isArray(existing)) {
      body.system = [ccIdentity, ...existing];
    } else if (typeof existing === "string") {
      body.system = [ccIdentity, { type: "text", text: existing }];
    } else {
      body.system = [ccIdentity];
    }
  }

  // Prepare request body
  let bodyPayload: string | Buffer | null = null;
  if (requestBody !== undefined && requestBody !== null) {
    if (typeof requestBody === "string") {
      bodyPayload = requestBody;
      if (!sanitizedHeaders["content-type"]) {
        sanitizedHeaders["content-type"] = "text/plain";
      }
    } else {
      bodyPayload = JSON.stringify(requestBody);
      if (!sanitizedHeaders["content-type"]) {
        sanitizedHeaders["content-type"] = "application/json";
      }
    }
  }

  // Log execution_requested event (async)
  // Use the original URL path (not targetUrl) to avoid logging Telegram bot tokens or Trello credentials
  const auditPath = new URL(url).pathname;
  logExecutionRequested(sub, policy.agentId, connectionId, {
    model: "B",
    method,
    path: auditPath,
    provider: connection.provider,
  });

  // Execute the HTTP request to the provider API via undici
  // undici 7.x does NOT follow redirects by default — 3xx responses are returned as-is
  const requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;

  // For streaming: cancel upstream request if client disconnects
  let abortController: AbortController | undefined;
  if (ctx.stream && ctx.rawRequest) {
    abortController = new AbortController();
    ctx.rawRequest.raw.on("close", () => abortController!.abort());
  }

  log?.info(
    { method, urlPath: auditPath, provider: connection.provider, timeout: requestTimeout, stream: !!ctx.stream, download: !!ctx.download, bodyLength: bodyPayload?.length },
    "vault.exec.outbound.start",
  );

  const httpStartTime = Date.now();
  let providerResponse;
  try {
    providerResponse = await undiciRequest(targetUrl.toString(), {
      method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
      headers: sanitizedHeaders,
      body: bodyPayload,
      headersTimeout: requestTimeout,
      bodyTimeout: ctx.stream ? 0 : requestTimeout, // No body timeout for streams
      signal: abortController?.signal,
    });
  } catch (err) {
    // Client disconnected during streaming — nothing to send back
    if (abortController?.signal.aborted) {
      return;
    }
    const httpElapsed = Date.now() - httpStartTime;
    const message = err instanceof Error ? err.message : "Provider request failed";
    (log ?? fastify.log).error({ connectionId, method, urlPath: auditPath, provider: connection.provider, elapsed: httpElapsed, error: message }, "vault.exec.outbound.failed");

    const { auditId } = logExecutionError(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      path: auditPath,
      error: message,
    });

    return reply.code(502).send({ error: "Provider request failed", auditId });
  }

  const elapsed = Date.now() - httpStartTime;
  const responseContentType = Array.isArray(providerResponse.headers["content-type"])
    ? providerResponse.headers["content-type"][0]
    : providerResponse.headers["content-type"];
  log?.info(
    { statusCode: providerResponse.statusCode, contentType: responseContentType, elapsed, provider: connection.provider, urlPath: auditPath },
    "vault.exec.outbound.done",
  );

  // If the provider returned a redirect (3xx), handle cross-origin redirects.
  // Trusted redirects (e.g. Microsoft Graph → SharePoint) are followed server-side.
  // Unknown cross-origin redirects are blocked.
  if (providerResponse.statusCode >= 300 && providerResponse.statusCode < 400) {
    const location = providerResponse.headers["location"];
    if (location && typeof location === "string") {
      try {
        const redirectUrl = new URL(location, targetUrl.toString());
        if (redirectUrl.origin !== targetUrl.origin) {
          // Check if this is a known trusted redirect for this provider
          const trusted = isTrustedRedirect(connection.provider, redirectUrl.origin);
          log?.debug(
            { statusCode: providerResponse.statusCode, redirectTo: redirectUrl.origin, trusted },
            "vault.exec.redirect",
          );
          if (trusted) {
            // SSRF check on the redirect target
            const redirectHostSafety = await checkHostSafety(redirectUrl.hostname);
            if (!redirectHostSafety.safe) {
              return reply.code(403).send({
                error: `Redirect target blocked by SSRF protection: ${redirectHostSafety.reason}`,
              });
            }

            // Follow the redirect server-side (no auth headers — redirect URL is pre-signed)
            try {
              const redirectResponse = await undiciRequest(redirectUrl.toString(), {
                method: "GET",
                headersTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
                bodyTimeout: ctx.stream ? 0 : DEFAULT_REQUEST_TIMEOUT_MS,
                signal: abortController?.signal,
              });
              // Replace providerResponse with the redirect response
              providerResponse = redirectResponse;
            } catch (redirectErr) {
              if (abortController?.signal.aborted) return;
              const message = redirectErr instanceof Error ? redirectErr.message : "Redirect follow failed";
              (log ?? fastify.log).error({ err: redirectErr, connectionId, redirectTo: redirectUrl.origin }, "Failed to follow trusted redirect");
              return reply.code(502).send({ error: `Failed to follow provider redirect: ${message}` });
            }
          } else {
            const reason = `Blocked cross-origin redirect from ${targetUrl.origin} to ${redirectUrl.origin}`;
            const { auditId } = logExecutionDenied(sub, policy.agentId, connectionId, {
              model: "B",
              method,
              url,
              reason,
              redirectTo: redirectUrl.origin,
            });

            return reply.code(403).send({
              error: reason,
              hint: `The provider API redirected to ${redirectUrl.origin} which is not in the trusted redirect list for ${connection.provider}. If this is expected, contact your admin.`,
              auditId,
            });
          }
        }
      } catch {
        // If we can't parse the redirect URL, block it as well
      }
    }
  }

  // ── Binary download: pipe raw bytes to client ──
  if (ctx.download && providerResponse.statusCode >= 200 && providerResponse.statusCode < 300) {
    reply.hijack();

    const upstreamCT = (
      Array.isArray(providerResponse.headers["content-type"])
        ? providerResponse.headers["content-type"][0]
        : providerResponse.headers["content-type"]
    ) ?? "application/octet-stream";
    const contentDisposition = Array.isArray(providerResponse.headers["content-disposition"])
      ? providerResponse.headers["content-disposition"][0]
      : providerResponse.headers["content-disposition"];
    const contentLength = Array.isArray(providerResponse.headers["content-length"])
      ? providerResponse.headers["content-length"][0]
      : providerResponse.headers["content-length"];

    // Some providers (Gmail, IMAP) return binary content as base64 inside JSON
    // (e.g., {"data": "<base64>", "size": 12345}). When download: true, detect
    // this pattern, decode the base64, and stream raw bytes instead so that
    // vault_download saves a usable binary file.
    const isJsonResponse = upstreamCT.includes("application/json");
    if (isJsonResponse) {
      const chunks: Buffer[] = [];
      for await (const chunk of providerResponse.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const jsonText = Buffer.concat(chunks).toString("utf-8");
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        // Gmail attachment API returns { data: "<base64>", size: N, attachmentId: "..." }
        // IMAP attachment returns { content: "<base64>", filename: "...", contentType: "...", size: N }
        const b64Data = (typeof parsed.data === "string" ? parsed.data : null)
          ?? (typeof parsed.content === "string" ? parsed.content : null);
        if (b64Data && b64Data.length > 100) {
          // Decode base64 (Gmail uses URL-safe base64 — handle both standard and URL-safe)
          const decoded = Buffer.from(b64Data, "base64url");
          // Infer content type from the JSON metadata or filename
          const inferredCT = (typeof parsed.contentType === "string" ? parsed.contentType : null)
            ?? (typeof parsed.mimeType === "string" ? parsed.mimeType : null)
            ?? "application/octet-stream";
          const filename = typeof parsed.filename === "string" ? parsed.filename : null;

          const responseHeaders: Record<string, string> = {
            "Content-Type": inferredCT,
            "Content-Length": String(decoded.length),
            "Cache-Control": "no-cache",
          };
          if (filename) {
            responseHeaders["Content-Disposition"] = `attachment; filename="${filename}"`;
          }
          reply.raw.writeHead(200, responseHeaders);
          reply.raw.end(decoded);
          logExecutionCompleted(sub, policy.agentId, connectionId, {
            model: "B", method, path: auditPath,
            responseStatus: providerResponse.statusCode,
            dataSize: decoded.length,
            provider: connection.provider,
          });
          return;
        }
      } catch {
        // Not valid JSON or no base64 field — fall through to raw pipe
      }
      // JSON but no base64 field — pipe the raw JSON
      const responseHeaders: Record<string, string> = {
        "Content-Type": upstreamCT,
        "Cache-Control": "no-cache",
      };
      if (contentLength) responseHeaders["Content-Length"] = contentLength;
      reply.raw.writeHead(providerResponse.statusCode, responseHeaders);
      reply.raw.end(Buffer.concat(chunks));
      logExecutionCompleted(sub, policy.agentId, connectionId, {
        model: "B", method, path: auditPath,
        responseStatus: providerResponse.statusCode,
        dataSize: Buffer.concat(chunks).length,
        provider: connection.provider,
      });
      return;
    }

    const responseHeaders: Record<string, string> = {
      "Content-Type": upstreamCT,
      "Cache-Control": "no-cache",
    };
    if (contentDisposition) responseHeaders["Content-Disposition"] = contentDisposition;
    if (contentLength) responseHeaders["Content-Length"] = contentLength;

    reply.raw.writeHead(providerResponse.statusCode, responseHeaders);

    let totalBytes = 0;
    try {
      for await (const chunk of providerResponse.body) {
        // Write raw Buffer — do NOT convert to string (corrupts binary data)
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        reply.raw.write(buf);
      }
    } catch (err) {
      if (!ctx.rawRequest?.raw.destroyed) {
        (log ?? fastify.log).error({ err, connectionId }, "Download streaming error");
      }
    } finally {
      reply.raw.end();
      // Audit log (fire-and-forget)
      logExecutionCompleted(sub, policy.agentId, connectionId, {
        model: "B",
        method,
        path: auditPath,
        responseStatus: providerResponse.statusCode,
        dataSize: totalBytes,
        provider: connection.provider,
      });
    }
    return;
  }

  // ── Streaming response: pipe directly to client with real-time filtering ──
  if (ctx.stream && providerResponse.statusCode >= 200 && providerResponse.statusCode < 300) {
    reply.hijack();

    // Forward upstream Content-Type (SSE, NDJSON, etc.)
    const upstreamContentType = (
      Array.isArray(providerResponse.headers["content-type"])
        ? providerResponse.headers["content-type"][0]
        : providerResponse.headers["content-type"]
    ) ?? "application/octet-stream";

    reply.raw.writeHead(providerResponse.statusCode, {
      "Content-Type": upstreamContentType,
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Nginx: don't buffer streams
    });

    const hasResponseRules = ctx.compiledRules && ctx.compiledRules.response.length > 0;
    let totalBytes = 0;
    let totalOutputBytes = 0;
    let chunkCount = 0;

    try {
      if (hasResponseRules) {
        // Real-time filtering: parse each SSE event / NDJSON line, apply rules, re-serialize
        const parsedStreamUrl = new URL(url);
        const filter = createStreamFilter(
          upstreamContentType,
          ctx.compiledRules!.response,
          method,
          parsedStreamUrl.pathname,
          parsedStreamUrl.search,
        );
        for await (const chunk of providerResponse.body) {
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
          totalBytes += text.length;
          chunkCount++;
          const filtered = filter.transform(text);
          if (filtered) {
            totalOutputBytes += filtered.length;
            reply.raw.write(filtered);
          }
        }
        const remaining = filter.flush();
        if (remaining) {
          totalOutputBytes += remaining.length;
          reply.raw.write(remaining);
        }
      } else {
        // No response rules — zero-overhead passthrough
        for await (const chunk of providerResponse.body) {
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
          totalBytes += text.length;
          totalOutputBytes += text.length;
          chunkCount++;
          reply.raw.write(text);
        }
      }
    } catch (err) {
      if (!ctx.rawRequest?.raw.destroyed) {
        (log ?? fastify.log).error({ err, connectionId, chunkCount, totalBytes, totalOutputBytes }, "Streaming error");
      }
    } finally {
      (log ?? fastify.log).info(
        { connectionId, provider: connection.provider, chunkCount, totalBytes, totalOutputBytes, filtered: hasResponseRules, contentType: upstreamContentType },
        "vault.stream.done",
      );
      reply.raw.end();
      // Audit log stream completion (fire-and-forget)
      logExecutionCompleted(sub, policy.agentId, connectionId, {
        model: "B",
        method,
        path: auditPath,
        responseStatus: providerResponse.statusCode,
        dataSize: totalBytes,
        provider: connection.provider,
      });
    }
    return;
  }

  // ── Transparent proxy: forward non-2xx responses raw ──
  // When used as a transparent LLM proxy (/vault/llm/), the SDK expects native
  // provider error responses (status code + body). Wrapping them in a vault
  // envelope causes SDKs to misclassify errors (e.g. 400 "prompt too long"
  // becomes "request timed out" because the SDK never sees the real error).
  if (ctx.transparentProxy && (providerResponse.statusCode < 200 || providerResponse.statusCode >= 300)) {
    let errorBody: string;
    try {
      errorBody = await providerResponse.body.text();
    } catch {
      errorBody = "";
    }

    const errorContentType = Array.isArray(providerResponse.headers["content-type"])
      ? providerResponse.headers["content-type"][0]
      : providerResponse.headers["content-type"];

    // Mark connection for reauth on 401 (same as the non-transparent path)
    if (providerResponse.statusCode === 401) {
      markConnectionNeedsReauth(
        connectionId,
        `Provider returned 401`,
        log ?? fastify.log,
      ).catch((err) => { (log ?? fastify.log).error({ err, connectionId }, "Failed to mark connection for reauth"); });
    }

    // Log structured error metadata (same as the non-transparent path)
    if (providerResponse.statusCode >= 400 && providerResponse.statusCode < 500) {
      let errorType: string | undefined;
      let errorMessage: string | undefined;
      try {
        const parsed = JSON.parse(errorBody);
        errorType = parsed?.error?.type;
        errorMessage = typeof parsed?.error?.message === "string"
          ? parsed.error.message.substring(0, 500)
          : undefined;
      } catch { /* not JSON */ }

      // Log outbound headers (secrets redacted) for LLM 4xx diagnostics
      if (["anthropic", "openai", "gemini", "openrouter"].includes(connection.provider)) {
        const safeHeaders = { ...sanitizedHeaders };
        delete safeHeaders["x-api-key"];
        delete safeHeaders["authorization"];
        (log ?? fastify.log).debug({ outboundHeaders: safeHeaders }, "vault.exec.llm.4xx.headers");
      }

      (log ?? fastify.log).warn(
        {
          connectionId,
          provider: connection.provider,
          statusCode: providerResponse.statusCode,
          urlPath: auditPath,
          ...(errorType && { errorType }),
          ...(errorMessage && { errorMessage }),
          // Include full error body for LLM providers (no sensitive data — only provider error descriptions)
          ...(["anthropic", "openai", "gemini", "openrouter"].includes(connection.provider)
            && { providerError: errorBody.substring(0, 2000) }),
        },
        "vault.exec.provider.clientError",
      );
    }

    logExecutionCompleted(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      path: auditPath,
      responseStatus: providerResponse.statusCode,
      dataSize: Buffer.byteLength(errorBody, "utf8"),
      provider: connection.provider,
    });

    return reply
      .code(providerResponse.statusCode)
      .header("content-type", errorContentType ?? "application/json")
      .send(errorBody);
  }

  // ── Early binary detection: skip buffering large binary bodies ──
  // Check content-type BEFORE reading the body. If it's binary and the agent
  // didn't request `download: true`, return metadata immediately instead of
  // buffering the entire file into memory (which can OOM or timeout).
  const earlyContentType = (
    Array.isArray(providerResponse.headers["content-type"])
      ? providerResponse.headers["content-type"][0]
      : providerResponse.headers["content-type"]
  ) ?? "";
  const isBinaryResponse =
    !ctx.download &&
    providerResponse.statusCode >= 200 &&
    providerResponse.statusCode < 300 &&
    (
      earlyContentType.includes("application/octet-stream") ||
      earlyContentType.includes("application/pdf") ||
      earlyContentType.includes("application/zip") ||
      earlyContentType.includes("application/vnd.") ||
      earlyContentType.startsWith("image/") ||
      earlyContentType.startsWith("audio/") ||
      earlyContentType.startsWith("video/")
    );

  if (isBinaryResponse) {
    // Drain the body without buffering to free the socket
    try { await providerResponse.body.dump(); } catch { /* ignore */ }

    const contentLength = providerResponse.headers["content-length"];
    const sizeStr = Array.isArray(contentLength) ? contentLength[0] : contentLength;
    const sizeBytes = sizeStr ? Number.parseInt(sizeStr, 10) : undefined;
    const contentDisposition = Array.isArray(providerResponse.headers["content-disposition"])
      ? providerResponse.headers["content-disposition"][0]
      : providerResponse.headers["content-disposition"];

    const { auditId } = logExecutionCompleted(sub, policy.agentId, connectionId, {
      model: "B",
      method,
      path: auditPath,
      responseStatus: providerResponse.statusCode,
      dataSize: sizeBytes ?? 0,
      provider: connection.provider,
    });

    return reply.code(200).send({
      model: "B",
      status: providerResponse.statusCode,
      headers: {},
      body: {
        _binaryContent: true,
        contentType: earlyContentType,
        ...(sizeBytes !== undefined && !Number.isNaN(sizeBytes) && { sizeBytes }),
        ...(contentDisposition && { contentDisposition }),
        hint: "Binary data cannot be returned through vault_execute. "
          + "Re-request this file using vault_download with these parameters: "
          + JSON.stringify({
            url,
            ...(SERVICE_CATALOG[connection.service as ServiceId]?.singleton
              ? { service: connection.service }
              : { connectionId }),
          }),
      },
      auditId,
    });
  }

  // ── Buffered response: read full body, filter, return JSON envelope ──
  let responseBody: string;
  try {
    responseBody = await providerResponse.body.text();
  } catch (err) {
    (log ?? fastify.log).error({ err, connectionId }, "Failed to read provider response body");
    responseBody = "";
  }
  // Enforce response size limit (use policy limit or default 10MB)
  const maxResponseSize = rateLimits?.maxResponseSizeBytes ?? DEFAULT_MAX_RESPONSE_SIZE_BYTES;
  const responseSizeBytes = Buffer.byteLength(responseBody, "utf8");
  if (responseSizeBytes > maxResponseSize) {
    // Truncate response body to configured limit
    const truncated = Buffer.from(responseBody, "utf8").subarray(0, maxResponseSize).toString("utf8");
    responseBody = truncated;
  }

  // Only 401 triggers reauth — we refresh tokens before every request,
  // so 403 after a successful refresh always means a permission/quota issue,
  // never a credential problem. This applies to all credential types.
  const shouldMarkReauth = providerResponse.statusCode === 401;

  if (shouldMarkReauth) {
    const wwwAuth = providerResponse.headers["www-authenticate"];
    (log ?? fastify.log).warn(
      {
        connectionId,
        provider: connection.provider,
        statusCode: providerResponse.statusCode,
        responseBody: responseBody?.substring(0, 500),
        wwwAuthenticate: Array.isArray(wwwAuth) ? wwwAuth[0] : wwwAuth,
      },
      "vault.exec.provider.authFailure",
    );
    markConnectionNeedsReauth(
      connectionId,
      `Provider returned ${providerResponse.statusCode}`,
      log ?? fastify.log,
    ).catch((err) => { (log ?? fastify.log).error({ err, connectionId }, "Failed to mark connection for reauth"); });
  }

  // Log structured error metadata for non-401 4xx responses (no body — may contain PII)
  if (!shouldMarkReauth && providerResponse.statusCode >= 400 && providerResponse.statusCode < 500 && ["anthropic", "openai", "gemini", "openrouter"].includes(connection.provider)) {
    // Log outbound headers (secrets redacted) for LLM 4xx diagnostics
    const safeHeaders = { ...sanitizedHeaders };
    delete safeHeaders["x-api-key"];
    delete safeHeaders["authorization"];
    (log ?? fastify.log).debug({ outboundHeaders: safeHeaders }, "vault.exec.llm.4xx.headers");
  }
  if (!shouldMarkReauth && providerResponse.statusCode >= 400 && providerResponse.statusCode < 500) {
    let errorType: string | undefined;
    let errorMessage: string | undefined;
    try {
      const parsed = JSON.parse(responseBody);
      // Anthropic/OpenAI style: { error: { type, message } }
      errorType = parsed?.error?.type;
      // Truncate to avoid leaking prompt content echoed in some provider errors
      errorMessage = typeof parsed?.error?.message === "string"
        ? parsed.error.message.substring(0, 500)
        : undefined;
    } catch { /* not JSON — skip */ }
    (log ?? fastify.log).warn(
      {
        connectionId,
        provider: connection.provider,
        statusCode: providerResponse.statusCode,
        urlPath: auditPath,
        ...(errorType && { errorType }),
        ...(errorMessage && { errorMessage }),
        // Include full error body for LLM providers (no sensitive data — only provider error descriptions)
        ...(["anthropic", "openai", "gemini", "openrouter"].includes(connection.provider)
          && { providerError: responseBody.substring(0, 2000) }),
      },
      "vault.exec.provider.clientError",
    );

  }

  // Convert response headers to a plain object
  const responseHeaders: Record<string, string> = {};
  const rawHeaders = providerResponse.headers;
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value !== undefined) {
      responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  // Parse response body based on content type
  let parsedBody: unknown;
  const contentType = responseHeaders["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      parsedBody = JSON.parse(responseBody);
    } catch {
      parsedBody = responseBody;
    }
  } else if (
    contentType.includes("application/octet-stream") ||
    contentType.includes("application/pdf") ||
    contentType.includes("application/zip") ||
    contentType.includes("application/vnd.") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("audio/") ||
    contentType.startsWith("video/")
  ) {
    // Binary content cannot be serialized through the JSON tool layer.
    // Return metadata instead of the raw bytes.
    const sizeBytes = Buffer.byteLength(responseBody, "utf8");
    parsedBody = {
      _binaryContent: true,
      contentType,
      sizeBytes,
      hint: "Binary data cannot be returned through vault_execute. "
        + "Re-request this file using vault_download with these parameters: "
        + JSON.stringify({
          url,
          ...(SERVICE_CATALOG[connection.service as ServiceId]?.singleton
            ? { service: connection.service }
            : { connectionId }),
        }),
    };
  } else {
    parsedBody = responseBody;
  }

  // ── Telegram inbound filtering: strip updates from non-trusted contacts ──
  if (
    connection.provider === "telegram" &&
    isTelegramGetUpdatesUrl(url) &&
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    providerResponse.statusCode >= 200 &&
    providerResponse.statusCode < 300
  ) {
    const pc = providerConstraints as { provider: string; allowedChatIds?: string[] } | null;
    const allowedChatIds = (pc?.provider === "telegram" ? pc.allowedChatIds : undefined) ?? [];
    if (allowedChatIds.length > 0) {
      const beforeCount = ((parsedBody as Record<string, unknown>)["result"] as unknown[] | undefined)?.length ?? 0;
      parsedBody = filterTelegramUpdates(parsedBody as Record<string, unknown>, allowedChatIds);
      const afterCount = ((parsedBody as Record<string, unknown>)["result"] as unknown[] | undefined)?.length ?? 0;
      if (beforeCount !== afterCount) {
        log?.info(
          { provider: "telegram", beforeCount, afterCount, filtered: beforeCount - afterCount },
          "vault.exec.telegramInboundFilter",
        );
      }
    }
  }

  // ── Slack inbound filtering: strip messages from non-trusted users, strip non-trusted channels ──
  if (
    connection.provider === "slack" &&
    isSlackReadMethod(url) &&
    typeof parsedBody === "object" &&
    parsedBody !== null &&
    providerResponse.statusCode >= 200 &&
    providerResponse.statusCode < 300
  ) {
    const pc = providerConstraints as { provider: string; allowedChannelIds?: string[]; allowedUserIds?: string[] } | null;
    const allowedChannelIds = (pc?.provider === "slack" ? pc.allowedChannelIds : undefined) ?? [];
    const allowedUserIds = (pc?.provider === "slack" ? pc.allowedUserIds : undefined) ?? [];

    // Filter conversations.list → only allowed channels + DMs for allowed users
    if (isSlackConversationsListUrl(url) && (allowedChannelIds.length > 0 || allowedUserIds.length > 0)) {
      const body = parsedBody as Record<string, unknown>;
      const beforeCount = (Array.isArray(body["channels"]) ? body["channels"].length : 0);
      parsedBody = filterSlackChannels(body, allowedChannelIds, allowedUserIds);
      const afterCount = (Array.isArray((parsedBody as Record<string, unknown>)["channels"]) ? ((parsedBody as Record<string, unknown>)["channels"] as unknown[]).length : 0);
      if (beforeCount !== afterCount) {
        log?.info(
          { provider: "slack", type: "channels", beforeCount, afterCount, filtered: beforeCount - afterCount },
          "vault.exec.slackInboundFilter",
        );
      }
    }

    // Filter conversations.history/replies → only allowed users, but ONLY for DM channels.
    // In regular channels, all messages are visible once the channel itself is allowed.
    // allowedUserIds controls which users can DM the agent, not message visibility in channels.
    if (isSlackConversationsHistoryUrl(url) && allowedUserIds.length > 0) {
      // Extract channel from request body or URL query string
      const reqChannel = extractSlackChannel(requestBody) ?? new URL(url).searchParams.get("channel");
      const isDmChannel = reqChannel ? (reqChannel.startsWith("D") || reqChannel.startsWith("G")) : false;

      if (isDmChannel) {
        const body = parsedBody as Record<string, unknown>;
        const beforeCount = (Array.isArray(body["messages"]) ? body["messages"].length : 0);
        parsedBody = filterSlackMessages(body, allowedUserIds);
        const afterCount = (Array.isArray((parsedBody as Record<string, unknown>)["messages"]) ? ((parsedBody as Record<string, unknown>)["messages"] as unknown[]).length : 0);
        if (beforeCount !== afterCount) {
          log?.info(
            { provider: "slack", type: "messages", channelId: reqChannel, beforeCount, afterCount, filtered: beforeCount - afterCount },
            "vault.exec.slackInboundFilter",
          );
        }
      }
    }
  }

  // ── Policy rules engine (post-execution): response filtering ──
  const hasResponseRulesBuffered = ctx.compiledRules && ctx.compiledRules.response.length > 0;
  log?.debug(
    { hasResponseRules: !!hasResponseRulesBuffered, responseSize: Buffer.byteLength(responseBody, "utf8") },
    "vault.exec.responseFilter",
  );
  if (hasResponseRulesBuffered && typeof parsedBody === "object" && parsedBody !== null) {
    const parsedResponseUrl = new URL(url);
    parsedBody = filterResponse(ctx.compiledRules!.response, method, parsedResponseUrl.pathname, parsedBody, parsedResponseUrl.search);
  }

  const dataSize = Buffer.byteLength(responseBody, "utf8");

  // Log execution_completed event (async)
  const { auditId } = logExecutionCompleted(sub, policy.agentId, connectionId, {
    model: "B",
    method,
    path: auditPath,
    responseStatus: providerResponse.statusCode,
    dataSize,
    provider: connection.provider,
  });

  // Transparent proxy: return raw provider JSON (no vault envelope) so the
  // SDK can parse the response natively (e.g. Anthropic Messages format).
  if (ctx.transparentProxy) {
    const ct = responseHeaders["content-type"] ?? "application/json";
    return reply
      .code(providerResponse.statusCode)
      .header("content-type", ct)
      .send(parsedBody);
  }

  const vaultResponse: Record<string, unknown> = {
    model: "B" as const,
    status: providerResponse.statusCode,
    headers: responseHeaders,
    body: parsedBody,
    auditId,
  };

  // Attach PII redaction metadata so the agent knows content was modified
  if (ctx.piiRedacted && ctx.piiRedactions && ctx.piiRedactions.length > 0) {
    vaultResponse.piiRedacted = true;
    vaultResponse.redactions = ctx.piiRedactions;
    vaultResponse.hint =
      "PII was detected and redacted from your request before forwarding to the provider. " +
      "The redacted fields contain [PII_REDACTED:type] placeholders. " +
      "If the original content is needed, re-submit the request with bypassPiiRedaction: true " +
      "to trigger a step-up approval for the workspace owner to review.";
  }

  return vaultResponse;
}
