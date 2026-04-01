import type {
  ExecuteInput,
  ExecuteOutput,
  ExecuteApprovalOutput,
  ApprovalRequestInput,
  ApprovalRequestOutput,
  ApprovalCommitInput,
  ApprovalCommitOutput,
  ConnectionsListOutput,
  ConnectionRevokeInput,
  ConnectionRevokeOutput,
  ConnectionListItem,
} from "./types.js";
import { VaultClient, VaultApiError } from "./client.js";

const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 5_000; // 5 seconds

/**
 * Executes an operation via the Vault's Model B brokered proxy.
 * Returns the execution result or approval requirement.
 */
export async function execute(
  client: VaultClient,
  input: ExecuteInput,
): Promise<ExecuteOutput | ExecuteApprovalOutput> {
  interface VaultExecuteResponse {
    // Model B fields
    model?: string;
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
    auditId?: string;
    // Approval fields
    approvalRequired?: boolean;
    approvalRequestId?: string;
  }

  const requestBody: Record<string, unknown> = {
    model: "B",
    method: input.method,
    url: input.url,
  };
  if (input.connectionId) requestBody.connectionId = input.connectionId;
  if (input.service) requestBody.service = input.service;
  if (input.query) requestBody.query = input.query;
  if (input.headers) requestBody.headers = input.headers;
  if (input.body !== undefined) requestBody.body = input.body;
  if (input.approvalId) requestBody.approvalId = input.approvalId;

  const response = await client.post<VaultExecuteResponse>("/v1/vault/execute", requestBody);

  if (response.approvalRequired) {
    return {
      approvalRequired: true,
      approvalRequestId: response.approvalRequestId ?? "",
      auditId: response.auditId ?? "",
    };
  }

  return {
    status: response.status ?? 0,
    headers: response.headers ?? {},
    body: response.body,
    auditId: response.auditId ?? "",
  };
}

/**
 * Creates a step-up approval request.
 * The user must approve before the action is executed.
 */
export async function approvalRequest(
  client: VaultClient,
  input: ApprovalRequestInput,
): Promise<ApprovalRequestOutput> {
  // Send a Model B execute request that will trigger step-up approval.
  // The Vault will detect the write method and create an approval request.
  const requestBody: Record<string, unknown> = {
    model: "B",
    connectionId: input.connectionId,
    method: input.method,
    url: input.url,
  };
  if (input.body !== undefined) requestBody.body = input.body;

  interface ApprovalResponse {
    approvalRequired: boolean;
    approvalRequestId: string;
    auditId: string;
  }

  const response = await client.post<ApprovalResponse>("/v1/vault/execute", requestBody);

  if (!response.approvalRequired) {
    throw new Error("Expected approval requirement but request was executed directly");
  }

  return {
    approvalRequestId: response.approvalRequestId,
    auditId: response.auditId,
  };
}

/**
 * Polls approval status until approved/denied/expired or timeout.
 * On approval, the caller should re-submit the original request
 * with the approvalId to execute it.
 */
export async function approvalCommit(
  client: VaultClient,
  input: ApprovalCommitInput,
  pollTimeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<ApprovalCommitOutput> {
  const timeout = input.timeoutMs ?? pollTimeoutMs;
  const deadline = Date.now() + timeout;

  interface ApprovalItem {
    id: string;
    status: string;
    expiresAt: string;
  }

  interface ApprovalsResponse {
    approvals: ApprovalItem[];
  }

  while (Date.now() < deadline) {
    // Check approval status
    const approvals = await client.get<ApprovalsResponse>("/v1/approvals");
    const approval = approvals.approvals.find((a) => a.id === input.approvalRequestId);

    if (!approval) {
      throw new Error(`Approval request ${input.approvalRequestId} not found`);
    }

    switch (approval.status) {
      case "approved": {
        // Approval granted — return a signal to the caller.
        // The caller should re-submit the original request with approvalId
        // via execute() to actually perform the operation.
        return {
          status: 200,
          headers: {},
          body: { approved: true, approvalRequestId: input.approvalRequestId },
          auditId: "",
        };
      }
      case "consumed":
        throw new Error("Approval request has already been used");
      case "denied":
        throw new Error("Approval request was denied by the user");
      case "expired":
        throw new Error("Approval request expired");
      case "pending":
        // Continue polling
        break;
      default:
        throw new Error(`Unexpected approval status: ${approval.status}`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Approval wait timed out after ${timeout}ms`);
}

/**
 * Lists all connections for the current workspace.
 */
export async function connectionsList(
  client: VaultClient,
): Promise<ConnectionsListOutput> {
  interface ConnectionsResponse {
    connections: ConnectionListItem[];
  }

  const response = await client.get<ConnectionsResponse>("/v1/connections");
  return { connections: response.connections };
}

/**
 * Revokes a connection immediately.
 */
export async function connectionRevoke(
  client: VaultClient,
  input: ConnectionRevokeInput,
): Promise<ConnectionRevokeOutput> {
  interface RevokeResponse {
    connection: { id: string; provider: string; label: string; status: string };
    auditId: string;
  }

  const response = await client.post<RevokeResponse>(
    `/v1/connections/${encodeURIComponent(input.connectionId)}/revoke`,
  );

  return {
    revoked: true,
    connectionId: response.connection.id,
    auditId: response.auditId,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
