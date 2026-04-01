/**
 * OpenClaw Gateway plugin configuration.
 */
export interface OpenClawPluginConfig {
  /** AgentHiFive Vault API base URL (e.g., "https://vault.example.com") */
  baseUrl: string;
  /** Authentication mode for Vault API */
  auth: OpenClawAuthConfig;
  /** Controls how much AgentHiFive plugin logging is surfaced in OpenClaw */
  debugLevel?: VaultDebugLevel;
  /** Default timeout for polling operations in milliseconds (default: 300_000 = 5 min) */
  pollTimeoutMs?: number;
  /** Polling interval for approval in milliseconds (default: 5_000) */
  pollIntervalMs?: number;
}

export type VaultDebugLevel = "silent" | "error" | "warn" | "info" | "debug";

export type OpenClawAuthConfig =
  | { mode: "agent"; privateKey: JsonWebKey; agentId: string; tokenAudience?: string }
  | { mode: "bearer"; token: string };

/**
 * Tool input/output types.
 */

export interface ExecuteInput {
  connectionId?: string;
  service?: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Approval request ID to bypass a require_approval guard (from a previous 202 response). */
  approvalId?: string;
}

export interface ExecuteOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  auditId: string;
}

export interface ExecuteApprovalOutput {
  approvalRequired: true;
  approvalRequestId: string;
  auditId: string;
}

export interface ApprovalRequestInput {
  connectionId: string;
  actionDescription: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  url: string;
  body?: unknown;
}

export interface ApprovalRequestOutput {
  approvalRequestId: string;
  auditId: string;
}

export interface ApprovalCommitInput {
  approvalRequestId: string;
  timeoutMs?: number;
}

export interface ApprovalCommitOutput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  auditId: string;
}

export interface ConnectionListItem {
  id: string;
  provider: string;
  label: string;
  status: string;
  grantedScopes: string[];
  createdAt: string;
}

export interface ConnectionsListOutput {
  connections: ConnectionListItem[];
}

export interface ConnectionRevokeInput {
  connectionId: string;
}

export interface ConnectionRevokeOutput {
  revoked: true;
  connectionId: string;
  auditId: string;
}

// ---------------------------------------------------------------------------
// Re-exports from extracted modules (M2)
// ---------------------------------------------------------------------------

export type {
  ActionProxy,
  ProxyRequest,
  ProxyResponse,
} from "./vault-action-proxy.js";

export type {
  CredentialProvider,
  CredentialQuery,
  CredentialResult,
  VaultProviderConfig,
} from "./vault-provider.js";

export type { VaultTokenManagerConfig } from "./vault-token-manager.js";

export type { SessionContext } from "./session-context.js";

export type {
  PendingApproval,
  PluginLogger,
} from "./pending-approvals.js";
