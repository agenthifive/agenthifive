/**
 * Configuration types for vault integration.
 */

export type VaultAuth =
  | { mode: "api_key"; apiKey: string }
  | { mode: "bearer"; token: string };

export type VaultConfig = {
  /** AgentHiFive vault base URL (e.g., "https://vault.agenthifive.com") */
  baseUrl: string;

  /** Authentication — API key or bearer token */
  auth: VaultAuth;

  /** Timeout for vault API calls (ms). Default: 5000 */
  timeoutMs?: number;

  /** Local cache TTL for vault-resolved credentials (ms). Default: 60000 */
  cacheTtlMs?: number;

  /** Timeout for brokered proxy calls (ms). Default: 65000.
   *  Higher than timeoutMs because Telegram getUpdates long-polls for 30s. */
  actionProxyTimeoutMs?: number;

  /**
   * Providers whose LLM traffic is proxied through AH5 (Model B for LLMs).
   * The vault credential provider skips credential resolution for these —
   * the agent API key is used for proxy auth instead.
   */
  proxiedProviders?: string[];

  /**
   * Map provider names to AgentHiFive connection UUIDs.
   * Required for brokered proxying — tells the vault which connection
   * to use for each provider's API calls.
   */
  connections?: Record<string, string>;

  /**
   * Capability checking and permission request configuration.
   */
  capabilities?: {
    /** Enable capability checking (default: true) */
    enabled?: boolean;
    /** Cache TTL for capabilities in ms (default: 60000) */
    cacheTtl?: number;
    /** Permission request settings */
    permissionRequest?: {
      /** Enable autonomous permission requests (default: true) */
      enabled?: boolean;
    };
  };
};

/**
 * Logger interface for SDK consumers to inject their own logging.
 * All methods are optional except info and error.
 */
export interface VaultLogger {
  info(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
  warn?(msg: string): void;
}

/** No-op logger — used as default when no logger is provided. */
export const noopLogger: VaultLogger = {
  info() {},
  error() {},
};

/** Console logger — convenient default for development. */
export const consoleLogger: VaultLogger = {
  info: (msg) => console.log(`[vault] ${msg}`),
  error: (msg) => console.error(`[vault] ${msg}`),
  debug: (msg) => console.debug(`[vault] ${msg}`),
  warn: (msg) => console.warn(`[vault] ${msg}`),
};
