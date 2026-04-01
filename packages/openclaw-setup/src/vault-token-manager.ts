/**
 * Manages JWT-based agent authentication for AgentHiFive vault.
 *
 * Signs ES256 client assertion JWTs, exchanges them for opaque `ah5t_` access
 * tokens via POST /v1/agents/token, and refreshes the token in the background
 * before expiry.
 *
 * The manager exposes a synchronous `getToken()` method so that callers
 * (buildAuthHeaders, etc.) don't need to be async — the background refresh
 * keeps the token fresh.
 */
import type { KeyLike } from "jose";
import { importES256Key, exchangeToken } from "./jwt-utils.js";

export type TokenExchangeFailureKind = "network" | "clock_skew" | "invalid_key" | "other";
export type VaultDebugLevel = "silent" | "error" | "warn" | "info" | "debug";
type VaultTokenManagerLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export function classifyTokenExchangeFailure(err: unknown): TokenExchangeFailureKind {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("\"reason\":\"clock_skew\"")
    || message.includes("\"reason\": \"clock_skew\"")
    || message.toLowerCase().includes("clock skew")
  ) {
    return "clock_skew";
  }
  if (
    message.includes("fetch failed")
    || message.includes("ENOTFOUND")
    || message.includes("ECONNREFUSED")
    || message.includes("ETIMEDOUT")
    || message.includes("EHOSTUNREACH")
    || message.toLowerCase().includes("network")
  ) {
    return "network";
  }
  if (message.includes("401")) {
    return "invalid_key";
  }
  return "other";
}

export type VaultTokenManagerConfig = {
  baseUrl: string;
  agentId: string;
  privateKey: JsonWebKey;
  tokenAudience?: string;
  debugLevel?: VaultDebugLevel;
  logger?: VaultTokenManagerLogger;
};

export class VaultTokenManager {
  private readonly baseUrl: string;
  private readonly agentId: string;
  private readonly privateKeyJWK: JsonWebKey;
  private readonly tokenAudience: string;
  private readonly debugLevel: VaultDebugLevel;
  private readonly logger: VaultTokenManagerLogger;

  private privateKeyObj: KeyLike | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0; // epoch ms
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  private lastVisibleFailureKey: string | null = null;
  private lastVisibleFailureAt = 0;

  /** Called after every successful token refresh with the new token. */
  onRefresh: ((newToken: string) => void) | null = null;

  /** Called when token refresh fails with 401 — indicates the agent's key is no longer valid. */
  onAuthFailure: (() => void) | null = null;

  constructor(config: VaultTokenManagerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.agentId = config.agentId;
    this.privateKeyJWK = config.privateKey;
    this.tokenAudience = (config.tokenAudience ?? this.baseUrl).replace(/\/+$/, "");
    this.debugLevel = config.debugLevel ?? "error";
    this.logger = config.logger ?? console;
  }

  private shouldLog(level: VaultDebugLevel): boolean {
    const rank: Record<VaultDebugLevel, number> = {
      silent: 0,
      error: 1,
      warn: 2,
      info: 3,
      debug: 4,
    };
    return rank[this.debugLevel] >= rank[level];
  }

  private emitLog(level: Exclude<VaultDebugLevel, "silent">, message: string): void {
    if (!this.shouldLog(level)) return;
    if (level === "debug") {
      (this.logger.debug ?? this.logger.info ?? this.logger.warn ?? this.logger.error)?.(message);
      return;
    }
    this.logger[level]?.(message);
  }

  /**
   * Perform the initial token exchange and start the background refresh timer.
   * Must be called (and awaited) before getToken().
   */
  async init(): Promise<void> {
    // Import the JWK once
    this.privateKeyObj = await importES256Key(this.privateKeyJWK);

    // Initial token exchange
    await this.refreshToken();

    // Schedule background refresh — check every 30s, refresh when near expiry
    this.refreshTimer = setInterval(() => {
      if (Date.now() >= this.tokenExpiresAt - 60_000) {
        this.refreshToken().catch(() => {});
      }
    }, 30_000);

    // Don't keep the process alive just for token refresh
    if (
      this.refreshTimer &&
      typeof this.refreshTimer === "object" &&
      "unref" in this.refreshTimer
    ) {
      this.refreshTimer.unref();
    }
  }

  /**
   * Get the current bearer token. Synchronous — relies on background refresh.
   * Throws if init() hasn't been called.
   */
  getToken(): string {
    if (!this.accessToken) {
      throw new Error("VaultTokenManager not initialized — call init() first");
    }
    return this.accessToken;
  }

  /** Stop the background refresh timer. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Force an immediate token refresh. Called on-demand when a 401 is received.
   * Coalesces concurrent requests — if a refresh is already in flight, callers
   * wait for the same promise instead of hammering the token endpoint.
   */
  async forceRefresh(): Promise<boolean> {
    if (this.refreshInFlight) {
      try {
        await this.refreshInFlight;
        return true;
      } catch {
        return false;
      }
    }

    const attempt = this.refreshToken();
    this.refreshInFlight = attempt;
    try {
      await attempt;
      return true;
    } catch {
      return false;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private emitVisibleFailure(kind: TokenExchangeFailureKind, err: unknown): void {
    const ttlLeft = Math.max(0, Math.round((this.tokenExpiresAt - Date.now()) / 1000));
    const prefix = this.accessToken?.slice(0, 4) ?? "none";
    const rawMessage = err instanceof Error ? err.message : String(err);
    const failureKey = `${kind}:${rawMessage}`;
    const now = Date.now();
    if (this.lastVisibleFailureKey === failureKey && now - this.lastVisibleFailureAt < 60_000) {
      return;
    }
    this.lastVisibleFailureKey = failureKey;
    this.lastVisibleFailureAt = now;

    if (kind === "clock_skew") {
      this.emitLog(
        "warn",
        "[vault-token-manager] Token exchange rejected because the system clock appears out of sync. " +
          "Sync the VM clock/NTP and retry; no reconfiguration should be needed.",
      );
      return;
    }

    if (kind === "invalid_key") {
      this.emitLog(
        "error",
        "[vault-token-manager] Token exchange rejected (401). " +
          "The agent's key pair is no longer valid — agent may have been disabled or key rotated. " +
          "Generate a bootstrap secret from the AgentHiFive dashboard (Agents → Bootstrap Secret), " +
          "then run `openclaw configure` to reconnect.",
      );
      return;
    }

    this.emitLog(
      kind === "network" ? "warn" : "error",
      `[vault-token-manager] refresh failed (current token expires in ${ttlLeft}s, ` +
        `prefix: ${prefix}): ${rawMessage}`,
    );
  }

  private async refreshToken(): Promise<void> {
    if (!this.privateKeyObj) {
      throw new Error("Private key not imported — call init() first");
    }

    try {
      const result = await exchangeToken(this.privateKeyObj, {
        baseUrl: this.baseUrl,
        agentId: this.agentId,
        tokenAudience: this.tokenAudience,
      });

      const previousToken = this.accessToken;
      this.accessToken = result.accessToken;
      this.tokenExpiresAt = Date.now() + result.expiresIn * 1000;
      this.lastVisibleFailureKey = null;
      this.lastVisibleFailureAt = 0;

      this.emitLog(
        "info",
        `[vault-token-manager] Token refreshed (prefix: ${this.accessToken.slice(0, 4)}..., ` +
          `ttl: ${result.expiresIn}s, previous: ${previousToken ? previousToken.slice(0, 4) + "..." : "none"})`,
      );

      // Notify listener (register.ts uses this to update the shared mutable auth object)
      this.onRefresh?.(this.accessToken);
    } catch (err) {
      const kind = classifyTokenExchangeFailure(err);
      this.emitVisibleFailure(kind, err);
      if (kind === "invalid_key") {
        this.onAuthFailure?.();
      }
      throw err;
    }
  }
}
