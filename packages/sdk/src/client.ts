import type {
  Connection,
  ConnectionStatus,
  OAuthProvider,
  ExecutionModel,
  DefaultMode,
  StepUpApproval,
  AllowlistEntry,
  RateLimit,
  TimeWindow,
  AuditEvent,
  AgentStatus,
} from "@agenthifive/contracts";
import { SignJWT, importJWK, type JWK, type KeyLike } from "jose";
import { AgentHiFiveError } from "./errors.js";

// ─── Client configuration ───────────────────────────────────────────────────

export interface AgentHiFiveClientConfig {
  /** Base URL of the AgentHiFive API (e.g., "https://api.agenthifive.com") */
  baseUrl: string;

  // ── Mode 1: Agent auth via private_key_jwt (primary) ──

  /** ES256 private key as JWK — used for signing client assertion JWTs */
  privateKey?: JWK;
  /** Agent UUID — required when using privateKey */
  agentId?: string;
  /** Expected audience for client assertions (defaults to baseUrl) */
  tokenAudience?: string;

  // ── Mode 2: Direct bearer token (PATs, testing, pre-obtained ah5t_ tokens) ──

  /** Bearer token to send directly in Authorization header */
  bearerToken?: string;
}

// ─── API response types ─────────────────────────────────────────────────────

export interface ConnectionSummary {
  id: string;
  provider: string;
  label: string;
  status: ConnectionStatus;
  grantedScopes: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ConnectStartResult {
  /** Authorization URL for browser redirect */
  authorizationUrl: string;
  /** Pending connection ID */
  pendingConnectionId: string;
}

export interface ExecuteModelAResult {
  model: "A";
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  auditId: string;
}

export interface ExecuteModelBResult {
  model: "B";
  status: number;
  headers: Record<string, string>;
  body: unknown;
  auditId: string;
}

export interface ExecuteApprovalResult {
  approvalRequired: true;
  approvalRequestId: string;
  auditId: string;
}

export type ExecuteResult =
  | ExecuteModelAResult
  | ExecuteModelBResult
  | ExecuteApprovalResult;

export interface ExecuteModelBOptions {
  connectionId: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface ApprovalRequest {
  id: string;
  policyId: string;
  agentId: string;
  connectionId: string;
  actor: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestDetails: Record<string, unknown>;
  expiresAt: string;
  createdAt: string;
  agentName: string;
  connectionLabel: string;
  connectionProvider: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  status: AgentStatus;
  enrolledAt: string | null;
  createdAt: string;
}

export interface CreateAgentOptions {
  name: string;
  description?: string;
  iconUrl?: string;
}

export interface CreateAgentResult {
  agent: AgentSummary;
  bootstrapSecret: string;
}

export interface PolicySummary {
  id: string;
  agentId: string;
  connectionId: string;
  allowedModels: ExecutionModel[];
  defaultMode: DefaultMode;
  stepUpApproval: StepUpApproval;
  allowlists: AllowlistEntry[];
  rateLimits: RateLimit | null;
  timeWindows: TimeWindow[];
  createdAt: string;
  updatedAt: string;
}

export interface CreatePolicyOptions {
  agentId: string;
  connectionId: string;
  allowedModels?: ExecutionModel[];
  defaultMode?: DefaultMode;
  stepUpApproval?: StepUpApproval;
}

export interface ServiceActionInfo {
  id: string;
  label: string;
  description: string;
  requiresApproval: boolean;
}

export interface ServiceInfo {
  id: string;
  name: string;
  provider: string;
  icon: string;
  actions: ServiceActionInfo[];
}

export interface ActiveConnection {
  connectionId: string;
  service: string;
  label: string;
  actionTemplateId: string | null;
}

export interface PendingCapabilityRequest {
  id: string;
  actionTemplateId: string;
  reason: string;
  requestedAt: string;
}

export interface AvailableAction {
  id: string;
  serviceId: string;
  label: string;
  description: string;
  requiresApproval: boolean;
}

export interface MyCapabilities {
  activeConnections: ActiveConnection[];
  pendingRequests: PendingCapabilityRequest[];
  availableActions: AvailableAction[];
}

export interface CapabilityRequest {
  id: string;
  actionTemplateId: string;
  reason: string;
  createdAt: string;
}

export interface AuditListOptions {
  agentId?: string;
  connectionId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  cursor?: string;
  limit?: number;
}

export interface AuditListResult {
  events: AuditEvent[];
  nextCursor: string | null;
}

export interface BootstrapResult {
  agentId: string;
  name: string;
  status: AgentStatus;
  workspaceId: string;
}

export interface TokenResult {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
}

// ─── Client class ───────────────────────────────────────────────────────────

/**
 * Official TypeScript client for the AgentHiFive authority delegation API.
 *
 * **Agent auth mode** (recommended): Uses ES256 private key to auto-sign
 * client assertion JWTs and exchange them for short-lived access tokens.
 *
 * **Bearer token mode**: Sends a pre-obtained token (PAT, ah5t_) directly.
 *
 * @example Agent auth
 * ```ts
 * const client = new AgentHiFiveClient({
 *   baseUrl: "https://api.agenthifive.com",
 *   privateKey: myES256PrivateKeyJWK,
 *   agentId: "my-agent-uuid",
 * });
 *
 * const caps = await client.getMyCapabilities();
 * const result = await client.execute({
 *   model: "B",
 *   connectionId: "conn-id",
 *   method: "GET",
 *   url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
 * });
 * ```
 *
 * @example Bearer token mode
 * ```ts
 * const client = new AgentHiFiveClient({
 *   baseUrl: "https://api.agenthifive.com",
 *   bearerToken: "ah5t_your_access_token",
 * });
 * ```
 */
export class AgentHiFiveClient {
  private readonly baseUrl: string;

  // Direct bearer token mode
  private directBearerToken: string | null;

  // Agent auth mode
  private privateKeyJWK: JWK | null;
  private privateKeyObj: KeyLike | null = null;
  private readonly agentId: string | null;
  private readonly tokenAudience: string;

  // Token cache
  private accessToken: string | null = null;
  private tokenExpiresAt: number = 0; // epoch ms

  constructor(config: AgentHiFiveClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");

    if (config.bearerToken) {
      this.directBearerToken = config.bearerToken;
      this.privateKeyJWK = null;
      this.agentId = null;
      this.tokenAudience = "";
    } else if (config.privateKey && config.agentId) {
      this.directBearerToken = null;
      this.privateKeyJWK = config.privateKey;
      this.agentId = config.agentId;
      this.tokenAudience = config.tokenAudience ?? config.baseUrl.replace(/\/+$/, "");
    } else {
      throw new Error(
        "AgentHiFiveClient requires either (privateKey + agentId) or bearerToken",
      );
    }
  }

  // ─── Auth methods (static, no auth required) ─────────────────────────

  /**
   * Bootstrap an agent using a bootstrap secret.
   * Works for both first enrollment (created → active) and key rotation (active → replace key).
   * This is a static method — no auth token needed.
   */
  static async bootstrap(
    baseUrl: string,
    bootstrapSecret: string,
    publicKey: JWK,
  ): Promise<BootstrapResult> {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/agents/bootstrap`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bootstrapSecret, publicKey }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `Bootstrap failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.error === "string") message = parsed.error;
      } catch { /* ignore */ }
      throw new AgentHiFiveError(message, response.status);
    }
    return (await response.json()) as BootstrapResult;
  }

  // ─── Connection methods ─────────────────────────────────────────────

  /**
   * Start an OAuth authorization code flow for a provider.
   * Returns authorization URL for browser redirect.
   */
  async connect(
    provider: OAuthProvider,
    options?: { label?: string; scopes?: string[] },
  ): Promise<ConnectStartResult> {
    const body: Record<string, unknown> = { provider };
    if (options?.label) body.label = options.label;
    if (options?.scopes) body.scopes = options.scopes;
    return this.post<ConnectStartResult>("/connections/start", body);
  }

  /**
   * List all connections for the current workspace.
   */
  async listConnections(): Promise<ConnectionSummary[]> {
    const data = await this.get<{ connections: ConnectionSummary[] }>("/connections");
    return data.connections;
  }

  /**
   * Revoke a connection immediately. Blocks all future token vending and execution.
   */
  async revokeConnection(connectionId: string): Promise<{ revoked: boolean; auditId: string }> {
    return this.post<{ revoked: boolean; auditId: string }>(
      `/connections/${encodeURIComponent(connectionId)}/revoke`,
    );
  }

  // ─── Execution methods ──────────────────────────────────────────────

  /**
   * Execute a request through the AgentHiFive gateway.
   *
   * **Model A** (token vending): Returns a short-lived access token.
   * **Model B** (brokered proxy): Executes HTTP request on your behalf.
   *
   * May return an approval requirement if step-up approval is configured.
   */
  async execute(options: { model: "A"; connectionId: string }): Promise<ExecuteResult>;
  async execute(options: ExecuteModelBOptions & { model: "B" }): Promise<ExecuteResult>;
  async execute(
    options: { model: "A"; connectionId: string } | (ExecuteModelBOptions & { model: "B" }),
  ): Promise<ExecuteResult> {
    return this.post<ExecuteResult>("/vault/execute", options);
  }

  // ─── Approval methods ───────────────────────────────────────────────

  /**
   * List approval requests for the current workspace.
   */
  async listApprovals(): Promise<ApprovalRequest[]> {
    const data = await this.get<{ approvals: ApprovalRequest[] }>("/approvals");
    return data.approvals;
  }

  /**
   * Approve a pending step-up approval request.
   * Executes the original Model B request and returns the result.
   */
  async approveAction(approvalRequestId: string): Promise<ExecuteModelBResult> {
    return this.post<ExecuteModelBResult>(
      `/approvals/${encodeURIComponent(approvalRequestId)}/approve`,
    );
  }

  /**
   * Deny a pending step-up approval request.
   */
  async denyAction(
    approvalRequestId: string,
  ): Promise<{ denied: boolean; approvalRequestId: string; auditId: string }> {
    return this.post<{ denied: boolean; approvalRequestId: string; auditId: string }>(
      `/approvals/${encodeURIComponent(approvalRequestId)}/deny`,
    );
  }

  // ─── Agent methods ──────────────────────────────────────────────────

  /**
   * List agents for the current workspace.
   */
  async listAgents(): Promise<AgentSummary[]> {
    const data = await this.get<{ agents: AgentSummary[] }>("/agents");
    return data.agents;
  }

  /**
   * Create a new agent in the current workspace.
   */
  async createAgent(options: CreateAgentOptions): Promise<CreateAgentResult> {
    return this.post<CreateAgentResult>("/agents", options);
  }

  // ─── Policy methods ─────────────────────────────────────────────────

  /**
   * List policies for the current workspace.
   */
  async listPolicies(): Promise<PolicySummary[]> {
    const data = await this.get<{ policies: PolicySummary[] }>("/policies");
    return data.policies;
  }

  /**
   * Create a policy binding between an agent and a connection.
   */
  async createPolicy(options: CreatePolicyOptions): Promise<PolicySummary> {
    const data = await this.post<{ policy: PolicySummary }>("/policies", options);
    return data.policy;
  }

  // ─── Capability methods ────────────────────────────────────────────

  /**
   * List all available services and their action templates.
   * Discover what capabilities AgentHiFive supports.
   */
  async listServices(): Promise<ServiceInfo[]> {
    const data = await this.get<{ services: ServiceInfo[] }>("/capabilities/services");
    return data.services;
  }

  /**
   * Get the calling agent's current capability status.
   * Returns active connections, pending requests, and available actions.
   */
  async getMyCapabilities(): Promise<MyCapabilities> {
    return this.get<MyCapabilities>("/capabilities/me");
  }

  /**
   * Request access to a capability. Creates a permission request that
   * the workspace owner can approve via the dashboard.
   *
   * Returns 409 if a request already exists or access is already granted.
   */
  async requestCapability(
    actionTemplateId: string,
    reason: string,
  ): Promise<CapabilityRequest> {
    return this.post<CapabilityRequest>("/agent-permission-requests", {
      actionTemplateId,
      reason,
    });
  }

  // ─── Audit methods ──────────────────────────────────────────────────

  /**
   * List audit events for the current workspace with optional filters.
   */
  async listAuditEvents(options?: AuditListOptions): Promise<AuditListResult> {
    const params = new URLSearchParams();
    if (options?.agentId) params.set("agentId", options.agentId);
    if (options?.connectionId) params.set("connectionId", options.connectionId);
    if (options?.action) params.set("action", options.action);
    if (options?.dateFrom) params.set("dateFrom", options.dateFrom);
    if (options?.dateTo) params.set("dateTo", options.dateTo);
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));

    const qs = params.toString();
    const path = qs ? `/audit?${qs}` : "/audit";
    return this.get<AuditListResult>(path);
  }

  // ─── Token management ──────────────────────────────────────────────

  /**
   * Get the current bearer token, refreshing if necessary.
   * In direct bearer mode, returns the configured token.
   * In agent auth mode, exchanges a client assertion for an access token.
   */
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

  private async refreshToken(): Promise<void> {
    if (!this.privateKeyJWK || !this.agentId) {
      throw new Error("Cannot refresh token without privateKey and agentId");
    }

    // Import private key on first use
    if (!this.privateKeyObj) {
      this.privateKeyObj = (await importJWK(this.privateKeyJWK, "ES256")) as KeyLike;
    }

    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(this.agentId)
      .setSubject(this.agentId)
      .setAudience(this.tokenAudience)
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .setJti(crypto.randomUUID())
      .sign(this.privateKeyObj);

    const response = await fetch(`${this.baseUrl}/v1/agents/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_assertion",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `Token exchange failed: ${response.status}`;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.error === "string") message = parsed.error;
      } catch { /* ignore */ }
      throw new AgentHiFiveError(message, response.status);
    }

    const result = (await response.json()) as TokenResult;
    this.accessToken = result.access_token;
    this.tokenExpiresAt = Date.now() + result.expires_in * 1000;
  }

  // ─── HTTP helpers ───────────────────────────────────────────────────

  private async get<T>(path: string): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    });
    return this.handleResponse<T>(response);
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const authHeader = await this.getAuthHeader();
    const headers: Record<string, string> = {
      Authorization: authHeader,
      Accept: "application/json",
    };
    const init: RequestInit = { method: "POST", headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await fetch(`${this.baseUrl}${path}`, init);
    return this.handleResponse<T>(response);
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `AgentHiFive API error: ${response.status} ${response.statusText}`;
      let auditId: string | undefined;
      let retryAfter: number | undefined;

      if (text) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed.error === "string") message = parsed.error;
          else if (typeof parsed.message === "string") message = parsed.message;
          if (typeof parsed.auditId === "string") auditId = parsed.auditId;
          if (typeof parsed.retryAfter === "number") retryAfter = parsed.retryAfter;
        } catch {
          message = text;
        }
      }

      // Check Retry-After header as fallback
      if (retryAfter === undefined) {
        const headerVal = response.headers.get("retry-after");
        if (headerVal) retryAfter = Number(headerVal);
      }

      throw new AgentHiFiveError(message, response.status, auditId, retryAfter);
    }

    // Handle 202 Accepted (approval required) — still a successful parse
    return (await response.json()) as T;
  }
}
