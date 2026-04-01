import type { CredentialProvider, CredentialQuery, CredentialResult } from "./types.js";
import type { VaultAuth } from "./config.js";

type VaultProviderConfig = {
  baseUrl: string;
  auth: VaultAuth;
  timeoutMs: number;
  cacheTtlMs: number;
  /** Providers proxied through AH5 — skip credential resolution for these */
  proxiedProviders?: string[];
  /** Capability checking and permission request configuration */
  capabilities?: {
    enabled: boolean;
    cacheTtl?: number;
    permissionRequest?: {
      enabled: boolean;
    };
  };
};

/**
 * Credential provider backed by AgentHiFive Vault.
 *
 * resolve() always returns null — all credential access goes through
 * vault/execute (Model A for token vending, Model B for brokered proxy)
 * or vault/llm proxy. The class is kept for isAvailable(), getConfig(),
 * and buildAuthHeaders() used by capability cache and permission request modules.
 */
export class VaultCredentialProvider implements CredentialProvider {
  readonly id = "agenthifive-vault";

  private config: VaultProviderConfig;

  constructor(config: VaultProviderConfig) {
    this.config = config;
  }

  async resolve(_query: CredentialQuery): Promise<CredentialResult | null> {
    // All credential resolution goes through vault/execute (Model B) or vault/llm proxy.
    // credentials/resolve is admin-only. Agents use vault/execute with model: "A" or "B".
    return null;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Get the vault provider configuration. */
  getConfig(): VaultProviderConfig {
    return this.config;
  }

  /** Build auth headers for vault API requests. */
  buildAuthHeaders(): Record<string, string> {
    if (this.config.auth.mode === "api_key") {
      return { "X-API-Key": this.config.auth.apiKey };
    }
    return { Authorization: `Bearer ${this.config.auth.token}` };
  }
}
