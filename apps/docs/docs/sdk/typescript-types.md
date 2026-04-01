---
title: TypeScript Types
sidebar_position: 4
sidebar_label: TypeScript Types
description: TypeScript types re-exported by the AgentHiFive SDK from @agenthifive/contracts.
---

# TypeScript Types

The SDK re-exports commonly used types from `@agenthifive/contracts` so you can import everything from a single package. These types are used throughout the SDK's method signatures and return values.

## Importing Types

```typescript
import type {
  Connection,
  ConnectionStatus,
  OAuthProvider,
  Agent,
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
} from "@agenthifive/sdk";
```

## Core Entity Types

| Type | Description |
|------|-------------|
| `Connection` | A connected OAuth provider account with token storage metadata. |
| `ConnectionStatus` | Union of connection lifecycle states (e.g., `"healthy"`, `"needs_reauth"`, `"revoked"`). |
| `OAuthProvider` | Supported OAuth provider identifiers (e.g., `"google"`, `"microsoft"`, `"telegram"`, `"github"`, `"slack"`). |
| `Agent` | A registered AI agent or application within a workspace. |
| `AgentStatus` | Agent lifecycle state: `"created"`, `"active"`, or `"disabled"`. |
| `Policy` | An access policy binding an agent to a connection with rules. |

## Policy Rule Types

| Type | Description |
|------|-------------|
| `ExecutionModel` | Execution model identifier: `"A"` (token vending) or `"B"` (brokered proxy). |
| `DefaultMode` | Default policy behavior: `"read_only"`, `"read_write"`, or `"custom"`. |
| `StepUpApproval` | Step-up approval configuration: `"always"`, `"risk_based"`, or `"never"`. |
| `AllowlistEntry` | URL pattern (baseUrl, pathPatterns) and HTTP methods permitted by a policy. |
| `RateLimit` | Rate limiting: maxRequestsPerHour, optional maxPayloadSizeBytes and maxResponseSizeBytes. |
| `TimeWindow` | Time-based access restrictions (e.g., business hours only). |

## Execution Types

| Type | Description |
|------|-------------|
| `ExecuteRequest` | Union of Model A and Model B execution requests. |
| `ExecuteRequestModelA` | Request shape for token vending (Model A). |
| `ExecuteRequestModelB` | Request shape for brokered proxy (Model B) -- includes `method`, `url`, `query`, `headers`, `body`. |
| `ExecuteResponse` | Discriminated union of all execution response types. |
| `ExecuteResponseModelA` | Response from Model A: contains `accessToken`, `tokenType`, `expiresIn`. |
| `ExecuteResponseModelB` | Response from Model B: contains `status`, `headers`, `body`. |
| `ExecuteResponseApproval` | Response when step-up approval is required: contains `approvalRequestId`. |

## Audit Types

| Type | Description |
|------|-------------|
| `AuditEvent` | A single audit log entry with timestamp, action, decision, and metadata. |
| `AuditDecision` | The outcome of a policy evaluation (e.g., `"allowed"`, `"denied"`, `"error"`). |

## SDK-Specific Types

These types are defined in the SDK itself (not re-exported from contracts):

```typescript
import type {
  AgentHiFiveClientConfig,
  ConnectionSummary,
  ConnectStartResult,
  ExecuteModelAResult,
  ExecuteModelBResult,
  ExecuteApprovalResult,
  ExecuteResult,
  ExecuteModelBOptions,
  ApprovalRequest,
  AgentSummary,
  CreateAgentOptions,
  CreateAgentResult,
  BootstrapResult,
  TokenResult,
  PolicySummary,
  CreatePolicyOptions,
  AuditListOptions,
  AuditListResult,
} from "@agenthifive/sdk";
```

| Type | Description |
|------|-------------|
| `AgentHiFiveClientConfig` | Constructor options for `AgentHiFiveClient` (`baseUrl`, `privateKey`+`agentId` or `bearerToken`). |
| `ConnectionSummary` | Simplified connection object returned by `listConnections()`. |
| `ConnectStartResult` | Result of `connect()` containing the `authorizationUrl`. |
| `ExecuteResult` | Discriminated union of `ExecuteModelAResult`, `ExecuteModelBResult`, and `ExecuteApprovalResult`. |
| `ExecuteModelBOptions` | Options for Model B execution: `connectionId`, `method`, `url`, `query`, `headers`, `body`. |
| `ApprovalRequest` | Enriched approval request with agent and connection metadata. |
| `AgentSummary` | Agent with `status` (`AgentStatus`) and `enrolledAt` (nullable). |
| `CreateAgentResult` | Created agent with `bootstrapSecret` (shown once). |
| `BootstrapResult` | Result of `AgentHiFiveClient.bootstrap()`: `agentId`, `name`, `status`, `workspaceId`. |
| `TokenResult` | Token exchange result: `access_token`, `token_type`, `expires_in`. |
| `PolicySummary` | Policy object with resolved allowlists, rate limits, and time windows. |
| `AuditListOptions` | Filter and pagination options for `listAuditEvents()`. |
| `AuditListResult` | Paginated audit event response with `events` array and `nextCursor`. |
