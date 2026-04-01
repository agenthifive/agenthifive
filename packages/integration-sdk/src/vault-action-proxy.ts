import type { ActionProxy, ProxyRequest, ProxyResponse } from "./action-proxy.js";
import type { VaultAuth } from "./config.js";

type VaultActionProxyConfig = {
  baseUrl: string;
  auth: VaultAuth;
  timeoutMs: number;
};

/**
 * Action proxy backed by AgentHiFive Vault.
 *
 * Routes API calls through POST /v1/vault/execute (Model B: brokered proxy).
 * The vault adds the credential (Authorization header), evaluates policies,
 * executes the request, and returns the response with an audit ID.
 */
export class VaultActionProxy implements ActionProxy {
  private config: VaultActionProxyConfig;

  constructor(config: VaultActionProxyConfig) {
    this.config = config;
  }

  async execute(request: ProxyRequest, callerSignal?: AbortSignal): Promise<ProxyResponse> {
    const vaultBody: Record<string, unknown> = {
      model: "B",
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      ...(request.context ? { context: request.context } : {}),
    };
    if (request.service) {
      vaultBody.service = request.service;
    }
    if (request.connectionId) {
      vaultBody.connectionId = request.connectionId;
    }

    // Combine our own timeout with the caller's abort signal (if any).
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

    const response = await fetch(`${this.config.baseUrl}/v1/vault/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.buildAuthHeader(),
      },
      body: JSON.stringify(vaultBody),
      signal,
    });

    const result = (await response.json()) as Record<string, unknown>;

    // The vault may return a policy block (still 200 status)
    if (result["blocked"]) {
      return {
        status: 0,
        headers: {},
        body: null,
        auditId: String(result["auditId"] ?? ""),
        blocked: {
          reason: String(result["reason"] ?? "Blocked by policy"),
          policy: String(result["policy"] ?? "unknown"),
        },
      };
    }

    // 403 from the vault = policy denial
    if (response.status === 403) {
      return {
        status: 403,
        headers: {},
        body: null,
        auditId: String(result["auditId"] ?? ""),
        blocked: {
          reason: String(result["error"] ?? "Denied by policy"),
          policy: "vault-policy",
        },
      };
    }

    // Success — return the proxied response
    return {
      status: (result["status"] as number) ?? response.status,
      headers: (result["headers"] as Record<string, string>) ?? {},
      body: result["body"] ?? null,
      auditId: String(result["auditId"] ?? ""),
    };
  }

  private buildAuthHeader(): Record<string, string> {
    if (this.config.auth.mode === "api_key") {
      return { "X-API-Key": this.config.auth.apiKey };
    }
    return { Authorization: `Bearer ${this.config.auth.token}` };
  }
}
