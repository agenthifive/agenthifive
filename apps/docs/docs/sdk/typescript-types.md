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
| `OAuthProvider` | Supported OAuth provider identifiers: `"google"`, `"microsoft"`, `"telegram"`, `"github"`, `"slack"`, `"anthropic"`, `"openai"`, `"gemini"`, `"openrouter"`, `"notion"`, `"trello"`, `"jira"`. |
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

### `RequestRuleAction`

Union of actions a request rule can take: `"allow"`, `"deny"`, `"require_approval"`, `"redact"`.

### `RequestRule`

A request rule evaluated by the policy engine (first-match wins).

| Property | Type | Description |
|----------|------|-------------|
| `label` | `string?` | Optional human-readable label for the rule. |
| `match.methods` | `HttpMethod[]?` | HTTP methods to match (e.g., `["GET", "POST"]`). |
| `match.urlPattern` | `string?` | URL pattern to match against the request URL. |
| `match.queryPattern` | `string?` | Query string pattern to match. |
| `match.body` | `BodyCondition[]?` | JSON body conditions (path + operator + value). |
| `match.pii` | `PiiMatchConfig?` | PII detection config -- scans request body fields for PII without mutating the payload. |
| `action` | `RequestRuleAction` | Action to take when the rule matches. |
| `redactConfig` | `RedactConfig?` | PII redaction config -- only used when `action` is `"redact"`. Specifies which PII types to detect and which body fields to walk. |

### `RedactPattern`

Specifies a PII pattern type for redaction. Has a `type` field (see below), an optional `pattern` (for `"custom"` type), and an optional `replacement` string.

**Groups** (expand to multiple recognizers):
`"all_pii"`, `"financial"`, `"identity"`, `"contact"`

**Generic patterns:**
`"email"`, `"phone"`, `"credit_card"`, `"iban"`, `"ip_address"`, `"url"`, `"crypto_wallet"`, `"date_of_birth"`, `"mac_address"`, `"secret_code"`

**US-specific:**
`"us_ssn"`, `"us_itin"`, `"us_passport"`, `"us_driver_license"`, `"us_bank_routing"`, `"us_npi"`

**UK-specific:**
`"uk_nhs"`, `"uk_nino"`

**Italy-specific:**
`"it_fiscal_code"`, `"it_vat"`, `"it_passport"`, `"it_identity_card"`, `"it_driver_license"`

**India-specific:**
`"in_aadhaar"`, `"in_pan"`

**Spain-specific:**
`"es_nif"`, `"es_nie"`

**Australia-specific:**
`"au_tfn"`, `"au_abn"`

**Other countries:**
`"pl_pesel"`, `"fi_pic"`, `"th_tnin"`, `"kr_rrn"`, `"sg_fin"`

**Legacy alias:** `"ssn"`

**Custom:** `"custom"` -- requires a `pattern` (regex) field.

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
| `ServiceInfo` | Service descriptor returned by `listServices()`: `id`, `name`, `provider`, `icon`, and `actions` array. |
| `ServiceActionInfo` | Action within a service: `id`, `label`, `description`, `requiresApproval`. |
| `MyCapabilities` | Agent capability status returned by `getMyCapabilities()`: `activeConnections`, `pendingRequests`, `availableActions`. |
| `ActiveConnection` | An active connection with `connectionId`, `service`, `label`, and `actionTemplateId` (nullable). |
| `PendingCapabilityRequest` | A pending capability request: `id`, `actionTemplateId`, `reason`, `requestedAt`. |
| `AvailableAction` | A discoverable action: `id`, `serviceId`, `label`, `description`, `requiresApproval`. |
| `CapabilityRequest` | Result of `requestCapability()`: `id`, `actionTemplateId`, `reason`, `createdAt`. |
