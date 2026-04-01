/**
 * Credential provider backed by AgentHiFive Vault.
 *
 * resolve() always returns null — all LLM credential access goes through
 * vault/llm proxy (Model B brokered). The class is kept for isAvailable(),
 * getConfig(), and buildAuthHeaders() used by tools and hooks.
 */

import { getCurrentSessionContext } from "./session-context.js";
import { consumeApprovedLlmApproval } from "./llm-approval-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CredentialQuery = {
  provider: string;
  scopes?: string[];
};

export type CredentialResult = {
  token: string;
  expiresAt?: number;
};

export interface CredentialProvider {
  readonly id: string;
  resolve(query: CredentialQuery): Promise<CredentialResult | null>;
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type VaultProviderConfig = {
  baseUrl: string;
  auth: { mode: "bearer"; token: string };
  timeoutMs: number;
  cacheTtlMs: number;
  /** Called on 401 to attempt a token refresh. Returns true if refresh succeeded. */
  onTokenRefresh?: () => Promise<boolean>;
};

export class VaultCredentialProvider implements CredentialProvider {
  readonly id = "agenthifive-vault";

  private config: VaultProviderConfig;

  constructor(config: VaultProviderConfig) {
    this.config = config;
  }

  async resolve(_query: CredentialQuery): Promise<CredentialResult | null> {
    // All LLM credential resolution goes through vault/llm proxy (Model B).
    // The patch in resolveApiKeyForProvider returns the vault bearer token
    // directly, and the provider baseUrl is redirected to the vault proxy.
    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getConfig(): VaultProviderConfig {
    return this.config;
  }

  buildAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.auth.token}`,
    };
    const sessionCtx = getCurrentSessionContext();
    if (sessionCtx?.sessionKey) {
      headers["x-ah5-session-key"] = sessionCtx.sessionKey;
      const approvalId = consumeApprovedLlmApproval(sessionCtx.sessionKey);
      if (approvalId) {
        headers["x-ah5-approval-id"] = approvalId;
      }
    }
    return headers;
  }
}
