/**
 * Shared LLM provider configuration and auth header building.
 *
 * Used by vault.ts (Model B execution), vault/llm transparent proxy,
 * and connections.ts (test endpoint, creation validation).
 */

export interface LlmProviderConfig {
  baseUrl: string;
  authHeader: string;
  /** Prefix prepended to the API key value (e.g., "Bearer " for Authorization header) */
  authPrefix?: string;
  extraHeaders?: Record<string, string>;
}

/**
 * LLM provider configurations: base URL, auth header name, optional prefix,
 * and optional fixed headers.
 */
export const LLM_PROVIDERS: Record<string, LlmProviderConfig> = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    authHeader: "x-api-key",
    extraHeaders: { "anthropic-version": "2023-06-01" },
  },
  openai: {
    // OpenAI SDK uses baseURL "https://api.openai.com/v1" (with /v1), unlike
    // Anthropic which puts /v1 in request paths. The SDK strips /v1 from paths,
    // so providerPath arrives as "chat/completions" or "responses" — we need
    // /v1 in the upstream base to reconstruct the correct URL.
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
  gemini: {
    // Google Gemini SDK puts the version in baseUrl, not in request paths.
    // Requests arrive as "models/gemini-3-pro:generateContent", so we need
    // /v1beta in the upstream base.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    authHeader: "x-goog-api-key",
  },
  openrouter: {
    // OpenRouter is OpenAI-compatible: same /v1 prefix, same Bearer auth.
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
  },
};

/** Map short provider name → service ID in SERVICE_CATALOG */
export const PROVIDER_TO_SERVICE: Record<string, string> = {
  anthropic: "anthropic-messages",
  openai: "openai",
  gemini: "gemini",
  openrouter: "openrouter",
  email: "email-imap",
};

/**
 * Build auth headers for a provider given an access token.
 *
 * Handles:
 * - Anthropic OAuth (sk-ant-oat-*) → Authorization: Bearer + Claude Code identity headers
 * - Anthropic API key → x-api-key + anthropic-version
 * - Gemini → x-goog-api-key
 * - OpenAI/OpenRouter → Authorization: Bearer
 * - Slack → Authorization: Bearer
 * - Notion → Authorization: Bearer + Notion-Version
 * - Other OAuth providers → Authorization: Bearer
 *
 * Does NOT handle Telegram (token injected into URL path, not headers),
 * Trello (key+token injected as query params, not headers),
 * or Jira (Basic auth requires email+token, handled in vault.ts).
 */
export function buildProviderAuthHeaders(
  provider: string,
  accessToken: string,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (provider === "anthropic") {
    if (accessToken.startsWith("sk-ant-oat")) {
      // Anthropic OAuth tokens use Bearer auth + Claude Code identity headers.
      // The oauth-2025-04-20 and claude-code-20250219 betas are REQUIRED —
      // without them Anthropic returns 401 "OAuth authentication is currently
      // not supported".
      headers["authorization"] = `Bearer ${accessToken}`;
      headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
      headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
      headers["x-app"] = "cli";
    } else {
      headers["x-api-key"] = accessToken;
    }
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }

  if (provider === "gemini") {
    headers["x-goog-api-key"] = accessToken;
    return headers;
  }

  if (provider === "notion") {
    headers["authorization"] = `Bearer ${accessToken}`;
    headers["notion-version"] = "2022-06-28";
    return headers;
  }

  // OpenAI, OpenRouter, Slack, Google, Microsoft, and other OAuth providers
  headers["authorization"] = `Bearer ${accessToken}`;
  return headers;
}
