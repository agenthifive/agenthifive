/**
 * Action proxy abstraction and AgentHiFive Vault implementation.
 *
 * When configured, routes outgoing API calls through the AgentHiFive vault
 * proxy (Model B: brokered proxy) instead of calling provider APIs directly.
 * This enables content filtering, action allowlists, rate limiting, and audit.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProxyRequest = {
  /** Which connection/credential to use (required for multi-account services) */
  connectionId?: string;
  /** Service ID for singleton services — vault resolves the connection server-side */
  service?: string;
  /** Target provider API */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Redeem a previously approved step-up approval */
  approvalId?: string;
  /** Context for policy evaluation */
  context?: {
    tool: string;
    action: string;
    channel?: string;
    agentId?: string;
  };
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  auditId: string;
  /** If blocked by policy or auth failure, this explains why */
  blocked?: {
    reason: string;
    policy: string;
    /** Actionable hint for the AI agent — tells it how to fix the issue */
    hint?: string;
    /** Present when policy is "step-up-approval" — use to poll and redeem */
    approvalRequestId?: string;
  };
};

export interface ActionProxy {
  execute(request: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

type VaultActionProxyConfig = {
  baseUrl: string;
  auth: { mode: "bearer"; token: string };
  timeoutMs: number;
  /** Called on 401 to attempt a token refresh. Returns true if refresh succeeded. */
  onTokenRefresh?: () => Promise<boolean>;
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
    if (request.approvalId) {
      vaultBody.approvalId = request.approvalId;
    }

    // Combine our own timeout with the caller's abort signal (if any).
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

    const doFetch = () =>
      fetch(`${this.config.baseUrl}/v1/vault/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.buildAuthHeader(),
        },
        body: JSON.stringify(vaultBody),
        signal,
      });

    let response = await doFetch();

    // 401 = token expired — try refreshing once before giving up
    if (response.status === 401 && this.config.onTokenRefresh) {
      const refreshed = await this.config.onTokenRefresh();
      if (refreshed) {
        response = await doFetch();
      }
    }

    // 401 = authentication failure
    if (response.status === 401) {
      const tokenPrefix = this.config.auth.token?.slice(0, 4) || "empty";
      console.warn(
        `[vault-action-proxy] 401 on POST /v1/vault/execute (token: ${tokenPrefix}..., ` +
          `service: ${request.service ?? "n/a"}, url: ${request.url})`,
      );
      return {
        status: 401,
        headers: {},
        body: null,
        auditId: "",
        blocked: {
          reason: "Vault authentication failed — the agent's access token is invalid or expired.",
          policy: "vault-auth",
          hint: "The vault connection is broken. Ask your admin to generate a bootstrap secret from the AgentHiFive dashboard (Agents → Bootstrap Secret), then run `openclaw configure` to reconnect.",
        },
      };
    }

    // Guard against non-JSON responses
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json") && !response.ok) {
      const text = await response.text();
      const preview = text.slice(0, 120).replace(/\n/g, " ");
      throw new Error(
        `Vault returned HTTP ${response.status} with non-JSON body (${contentType || "no content-type"}): ${preview}`,
      );
    }

    const result = (await response.json()) as Record<string, unknown>;

    // Policy block
    if (result["blocked"]) {
      return {
        status: 0,
        headers: {},
        body: null,
        auditId: (result["auditId"] as string) ?? "",
        blocked: {
          reason: (result["reason"] as string) ?? "Blocked by policy",
          policy: (result["policy"] as string) ?? "unknown",
        },
      };
    }

    // 202 = step-up approval required
    if (response.status === 202 && result["approvalRequired"]) {
      const approvalRequestId = (result["approvalRequestId"] as string) ?? undefined;
      const blocked: ProxyResponse["blocked"] = {
        reason: (result["hint"] as string) ?? "This request requires human approval.",
        policy: "step-up-approval",
      };
      if (approvalRequestId) {
        blocked.hint = `Approval required. approvalRequestId: ${approvalRequestId}`;
        blocked.approvalRequestId = approvalRequestId;
      }
      return {
        status: 202,
        headers: {},
        body: null,
        auditId: (result["auditId"] as string) ?? "",
        blocked,
      };
    }

    // 403 = policy denial
    if (response.status === 403) {
      return {
        status: 403,
        headers: {},
        body: null,
        auditId: (result["auditId"] as string) ?? "",
        blocked: {
          reason: (result["error"] as string) ?? "Denied by policy",
          policy: "vault-policy",
        },
      };
    }

    // Success
    return {
      status: (result["status"] as number) ?? response.status,
      headers: (result["headers"] as Record<string, string>) ?? {},
      body: result["body"] ?? null,
      auditId: (result["auditId"] as string) ?? "",
    };
  }

  /** Vault base URL — used by the approval poller to call GET /v1/approvals/:id */
  get baseUrl(): string {
    return this.config.baseUrl;
  }

  /** Build auth header with current bearer token */
  buildAuthHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.auth.token}` };
  }

  /** Force a token refresh. Returns true if the token was successfully refreshed. */
  async refreshToken(): Promise<boolean> {
    if (!this.config.onTokenRefresh) {
      return false;
    }
    return this.config.onTokenRefresh();
  }
}
