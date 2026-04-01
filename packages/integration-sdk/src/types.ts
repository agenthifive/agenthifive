/**
 * Pluggable credential provider abstraction.
 *
 * When configured, an AI agent framework delegates credential resolution to an
 * external vault (e.g., AgentHiFive) instead of reading from local auth profiles
 * or env vars.
 *
 * The provider chain:
 *   vault → local (when provider = "vault+local")
 * If vault returns null or is unreachable, existing local resolution takes over.
 */

export type CredentialQuery = {
  /** What kind of credential is being requested */
  kind: "model_provider" | "channel" | "plugin_config";

  /** Provider/channel identifier (e.g., "openai", "telegram", "twilio") */
  provider: string;

  /** Optional account/profile ID for multi-account setups */
  profileId?: string;

  /** Optional hint about which config fields are needed */
  fields?: string[];
};

export type CredentialResult = {
  /** The resolved credential value (API key, token, etc.) */
  apiKey?: string;

  /** Additional fields for multi-field credentials (e.g., Slack bot+app token) */
  extra?: Record<string, string>;

  /** Source description for audit/debugging */
  source: string;

  /** Auth mode classification */
  mode?: "api-key" | "oauth" | "token" | "aws-sdk";

  /** Optional TTL hint — how long this credential can be cached locally (ms) */
  cacheTtlMs?: number;
};

export interface CredentialProvider {
  /** Unique identifier for this provider (e.g., "local", "agenthifive-vault") */
  readonly id: string;

  /**
   * Resolve a credential for the given query.
   * Return null to signal "I don't have this credential, try next provider".
   */
  resolve(query: CredentialQuery): Promise<CredentialResult | null>;

  /**
   * Store/update a credential (e.g., after OAuth refresh).
   * Optional — local-only providers may not support remote storage.
   */
  store?(query: CredentialQuery, credential: CredentialResult): Promise<void>;

  /**
   * Revoke/delete a credential.
   * Optional — used for cleanup on disconnect.
   */
  revoke?(query: CredentialQuery): Promise<void>;

  /**
   * Health check — can this provider serve credentials right now?
   * Used for graceful fallback when vault is unreachable.
   */
  isAvailable?(): Promise<boolean>;
}
