/**
 * Runtime exports for OpenClaw core patches.
 *
 * State is shared via globalThis.__ah5_runtime to avoid ESM module cache
 * issues — the plugin (loaded from extensions/) and the patch (in OpenClaw's
 * dist/) may get different module instances despite importing the same URL.
 * Using globalThis guarantees a single shared state within the process.
 *
 * Separate entry point from index.ts so patches import only what they need.
 */

import type { CredentialProvider } from "./vault-provider.js";

// ---------------------------------------------------------------------------
// Patch-facing types (stable API contract for the model-auth.ts patch)
// ---------------------------------------------------------------------------

/**
 * Query for credential resolution from the patch.
 * Mirrors the fork's CredentialQuery shape used in model-auth.ts.
 */
export type RuntimeCredentialQuery = {
  kind: "model_provider" | "channel" | "plugin_config";
  provider: string;
  profileId?: string;
  fields?: string[];
};

/**
 * Result returned to the patch from credential resolution.
 */
export type RuntimeCredentialResult = {
  apiKey: string;
  source?: string;
  mode?: "api-key" | "oauth" | "token";
};

// ---------------------------------------------------------------------------
// Global state — shared between plugin and patch via globalThis
// ---------------------------------------------------------------------------

interface Ah5RuntimeState {
  vaultBearerToken: string | null;
  credentialProvider: CredentialProvider | null;
  proxiedProviders: string[];
  currentSessionKey: string | null;
  approvedLlmApprovals: Record<string, string>;
}

const GLOBAL_KEY = "__ah5_runtime" as const;

function getState(): Ah5RuntimeState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      vaultBearerToken: null,
      credentialProvider: null,
      proxiedProviders: [],
      currentSessionKey: null,
      approvedLlmApprovals: {},
    };
  }
  return g[GLOBAL_KEY] as Ah5RuntimeState;
}

// ---------------------------------------------------------------------------
// Setup (called by register.ts)
// ---------------------------------------------------------------------------

/**
 * Called by register.ts after agent auth is initialized.
 * Sets the vault bearer token getter for Tier 0 proxied providers.
 */
export function setVaultBearerToken(token: string | null): void {
  getState().vaultBearerToken = token;
}

/**
 * Called by register.ts to set the credential provider for Tier 0.5 resolution.
 */
export function setCredentialProvider(provider: CredentialProvider | null): void {
  getState().credentialProvider = provider;
}

/**
 * Provider aliases — OpenClaw uses different internal names for some providers.
 * For example, Gemini is "gemini" in our config but "google" in OpenClaw's
 * resolveApiKeyForProvider(). The patch checks proxiedProviders.includes(provider),
 * so we must include all aliases.
 */
const PROVIDER_ALIASES: Record<string, string[]> = {
  gemini: ["gemini", "google"],
};

/**
 * Called by register.ts to set the list of providers that should use vault bearer tokens.
 * Automatically expands known aliases (e.g., "gemini" → ["gemini", "google"]).
 */
export function setProxiedProviders(providers: string[]): void {
  const expanded = new Set<string>();
  for (const p of providers) {
    expanded.add(p);
    for (const alias of PROVIDER_ALIASES[p] ?? []) {
      expanded.add(alias);
    }
  }
  getState().proxiedProviders = [...expanded];
}

// ---------------------------------------------------------------------------
// Patch-facing API
// ---------------------------------------------------------------------------

/**
 * Get the current vault bearer token for proxied provider auth.
 * Returns null if the plugin is not initialized or no token is available.
 */
export function getVaultBearerToken(): string | null {
  return getState().vaultBearerToken;
}

/**
 * Get the list of providers configured for vault token proxying.
 */
export function getProxiedProviders(): string[] {
  return getState().proxiedProviders;
}

/**
 * Resolve credentials via the configured credential provider chain.
 * Returns null if no provider is configured or no credentials are found.
 *
 * Adapts between the patch-facing types (RuntimeCredentialQuery/Result)
 * and the internal CredentialProvider interface.
 */
export async function resolveCredential(
  query: RuntimeCredentialQuery,
): Promise<RuntimeCredentialResult | null> {
  const state = getState();
  if (!state.credentialProvider) return null;

  const internalQuery: import("./vault-provider.js").CredentialQuery = {
    provider: query.provider,
  };
  if (query.fields) internalQuery.scopes = query.fields;

  const result = await state.credentialProvider.resolve(internalQuery);

  if (!result) return null;

  return {
    apiKey: result.token,
    source: `credential-provider:${state.credentialProvider.id}`,
    mode: "api-key",
  };
}

/**
 * Check whether the runtime has been initialized (plugin is loaded and auth is ready).
 */
export function isInitialized(): boolean {
  const state = getState();
  return state.vaultBearerToken !== null || state.credentialProvider !== null;
}
