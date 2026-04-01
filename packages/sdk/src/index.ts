// Client
export {
  AgentHiFiveClient,
  type AgentHiFiveClientConfig,
  type ConnectionSummary,
  type ConnectStartResult,
  type ExecuteModelAResult,
  type ExecuteModelBResult,
  type ExecuteApprovalResult,
  type ExecuteResult,
  type ExecuteModelBOptions,
  type ApprovalRequest,
  type AgentSummary,
  type CreateAgentOptions,
  type CreateAgentResult,
  type PolicySummary,
  type CreatePolicyOptions,
  type AuditListOptions,
  type AuditListResult,
  type BootstrapResult,
  type TokenResult,
} from "./client.js";

// Errors
export { AgentHiFiveError } from "./errors.js";

// Re-export commonly used types from contracts
export type {
  Connection,
  ConnectionStatus,
  OAuthProvider,
  Agent,
  AgentStatus,
  Policy,
  ExecutionModel,
  DefaultMode,
  StepUpApproval,
  AllowlistEntry,
  RateLimit,
  TimeWindow,
  AuditEvent,
  AuditDecision,
  ExecuteRequest,
  ExecuteRequestModelA,
  ExecuteRequestModelB,
  ExecuteResponse,
  ExecuteResponseModelA,
  ExecuteResponseModelB,
  ExecuteResponseApproval,
} from "@agenthifive/contracts";
