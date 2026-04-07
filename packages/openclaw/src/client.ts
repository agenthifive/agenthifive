import type { KeyLike } from "jose";
import type { OpenClawPluginConfig } from "./types.js";
import { importES256Key, exchangeToken, TokenExchangeError } from "./jwt-utils.js";
import { getCurrentSessionContext } from "./session-context.js";

/**
 * Lightweight HTTP client for communicating with the AgentHiFive Vault API.
 * Supports agent auth (private_key_jwt with auto token refresh) and direct bearer tokens.
 */
export class VaultClient {
  private readonly baseUrl: string;

  // Direct bearer mode
  private directBearerToken: string | null;

  // Agent auth mode
  private privateKeyJWK: JsonWebKey | null;
  private privateKeyObj: KeyLike | null = null;
  private agentId: string | null;
  private tokenAudience: string;

  // Token cache
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0; // epoch ms

  constructor(config: OpenClawPluginConfig) {
    // Strip trailing slash
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");

    if (config.auth.mode === "bearer") {
      this.directBearerToken = config.auth.token;
      this.privateKeyJWK = null;
      this.agentId = null;
      this.tokenAudience = "";
    } else {
      // agent mode
      this.directBearerToken = null;
      this.privateKeyJWK = config.auth.privateKey;
      this.agentId = config.auth.agentId;
      this.tokenAudience = config.auth.tokenAudience ?? this.baseUrl;
    }
  }

  private async getAuthHeader(): Promise<string> {
    if (this.directBearerToken) {
      return `Bearer ${this.directBearerToken}`;
    }

    // Refresh token if expired or expiring within 30s
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt - 30_000) {
      await this.refreshToken();
    }
    return `Bearer ${this.accessToken}`;
  }

  private buildHeaders(authHeader: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: "application/json",
    };

    const sessionCtx = getCurrentSessionContext();
    if (sessionCtx?.sessionKey) {
      headers["x-ah5-session-key"] = sessionCtx.sessionKey;
    }

    return headers;
  }

  private async refreshToken(): Promise<void> {
    if (!this.privateKeyJWK || !this.agentId) {
      throw new Error("Cannot refresh token without privateKey and agentId");
    }

    if (!this.privateKeyObj) {
      this.privateKeyObj = await importES256Key(this.privateKeyJWK);
    }

    try {
      const result = await exchangeToken(this.privateKeyObj, {
        baseUrl: this.baseUrl,
        agentId: this.agentId,
        tokenAudience: this.tokenAudience,
      });
      this.accessToken = result.accessToken;
      this.tokenExpiresAt = Date.now() + result.expiresIn * 1000;
    } catch (err) {
      if (err instanceof TokenExchangeError) {
        throw new VaultApiError(err.message, err.statusCode);
      }
      throw err;
    }
  }

  async get<T>(path: string): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.buildHeaders(authHeader),
    });
    return this.handleResponse<T>(response);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const headers = this.buildHeaders(authHeader);
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, init);
    return this.handleResponse<T>(response);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const headers = this.buildHeaders(authHeader);
    const init: RequestInit = { method: "PUT", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, init);
    return this.handleResponse<T>(response);
  }

  /**
   * POST with raw Response returned (for download: true requests that return binary).
   * Caller is responsible for checking response.ok and reading the body.
   */
  async postRaw(path: string, body?: unknown): Promise<Response> {
    const authHeader = await this.getAuthHeader();
    const headers = this.buildHeaders(authHeader);
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetch(`${this.baseUrl}${path}`, init);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `Vault API error: ${response.status} ${response.statusText}`;
      if (text) {
        try {
          const parsed = JSON.parse(text) as { error?: string; message?: string };
          if (parsed.error) message = parsed.error;
          else if (parsed.message) message = parsed.message;
        } catch {
          message = text;
        }
      }
      throw new VaultApiError(message, response.status);
    }
    return (await response.json()) as T;
  }
}

export class VaultApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "VaultApiError";
  }
}
