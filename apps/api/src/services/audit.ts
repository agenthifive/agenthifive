import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { auditEvents } from "../db/schema/audit-events";

/** Logger interface matching Fastify's logger (or any compatible logger). */
interface AuditLogger {
  error: (...args: unknown[]) => void;
}

/** Fallback console logger when no Fastify logger is available. */
const defaultLogger: AuditLogger = {
  error: (...args: unknown[]) => console.error("[audit]", ...args),
};

/**
 * Parameters for logging an audit event.
 * Matches the audit_events table schema.
 */
export interface AuditEventInput {
  actor: string;
  agentId?: string | null;
  connectionId?: string | null;
  action: string;
  decision: "allowed" | "denied" | "error";
  metadata?: Record<string, unknown>;
}

/** Result from logEvent — the generated auditId for caller to include in responses. */
export interface AuditEventResult {
  auditId: string;
}

/** Module-level logger reference, set via `setAuditLogger`. */
let _logger: AuditLogger = defaultLogger;

/**
 * Set the logger used for audit write failure reporting.
 * Call once during server startup with the Fastify logger instance.
 */
export function setAuditLogger(logger: AuditLogger): void {
  _logger = logger;
}

/**
 * Log an audit event asynchronously (fire-and-forget).
 * Never blocks the caller — errors are logged to the configured logger.
 *
 * @returns The generated auditId immediately (before the DB write completes).
 */
export function logEvent(event: AuditEventInput): AuditEventResult {
  const auditId = randomUUID();

  db.insert(auditEvents)
    .values({
      auditId,
      actor: event.actor,
      agentId: event.agentId ?? null,
      connectionId: event.connectionId ?? null,
      action: event.action,
      decision: event.decision,
      metadata: event.metadata ?? {},
    })
    .then(() => {})
    .catch((err) => {
      _logger.error({ err, auditId, action: event.action }, `Failed to log audit event: ${event.action}`);
    });

  return { auditId };
}

// ────────────────── Typed event helpers ──────────────────
// These provide convenience and document the expected metadata shapes
// for each audit event type. All are thin wrappers around logEvent().

// ── Model A: Token Vending ──

export function logTokenVended(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; provider: string; ttl: number },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "token_vended",
    decision: "allowed",
    metadata: meta,
  });
}

export function logTokenVendDenied(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { reason: string; model: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "token_vend_denied",
    decision: "denied",
    metadata: meta,
  });
}

// ── Model B: Execution ──

export function logExecutionRequested(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; method: string; path: string; provider: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "execution_requested",
    decision: "allowed",
    metadata: meta,
  });
}

export function logExecutionCompleted(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; method: string; path: string; responseStatus: number; dataSize: number; provider: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "execution_completed",
    decision: "allowed",
    metadata: meta,
  });
}

export function logExecutionError(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; method: string; path: string; error: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "execution_completed",
    decision: "error",
    metadata: meta,
  });
}

export function logExecutionDenied(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; method: string; url: string; reason: string; [key: string]: unknown },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "execution_denied",
    decision: "denied",
    metadata: meta,
  });
}

// ── Rate Limiting ──

export function logRateLimitExceeded(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; limit: number; currentCount: number; method?: string; url?: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "rate_limit_exceeded",
    decision: "denied",
    metadata: meta,
  });
}

// ── Connection Management ──

export function logConnectionRevoked(
  actor: string,
  connectionId: string,
  meta: { provider: string; label: string; previousStatus: string },
): AuditEventResult {
  return logEvent({
    actor,
    connectionId,
    action: "connection_revoked",
    decision: "allowed",
    metadata: meta,
  });
}

export function logConnectionNeedsReauth(
  connectionId: string,
  meta: { reason: string },
): AuditEventResult {
  return logEvent({
    actor: "system",
    connectionId,
    action: "connection_needs_reauth",
    decision: "allowed",
    metadata: meta,
  });
}

// ── Policy Management ──

export function logPolicyCreated(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { policyId: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "policy_created",
    decision: "allowed",
    metadata: meta,
  });
}

export function logPolicyUpdated(
  actor: string,
  agentId: string,
  connectionId: string | null,
  meta: { policyId: string; [key: string]: unknown },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "policy_updated",
    decision: "allowed",
    metadata: meta,
  });
}

export function logPolicyDeleted(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { policyId: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "policy_deleted",
    decision: "allowed",
    metadata: meta,
  });
}

// ── Approval Workflow ──

export function logApprovalRequested(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { model: string; method: string; url: string; approvalRequestId: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "approval_requested",
    decision: "allowed",
    metadata: meta,
  });
}

export function logApprovalApproved(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { approvalRequestId: string; via?: string | undefined },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "approval_approved",
    decision: "allowed",
    metadata: meta,
  });
}

export function logApprovalDenied(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { approvalRequestId: string; via?: string | undefined },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "approval_denied",
    decision: "denied",
    metadata: meta,
  });
}

// ── Agent Management ──

export function logAgentUpdated(
  actor: string,
  agentId: string,
  meta: { fields: string[] },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    action: "agent_updated",
    decision: "allowed",
    metadata: meta,
  });
}

export function logAgentDeleted(
  actor: string,
  agentId: string,
  meta: { name: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    action: "agent_deleted",
    decision: "allowed",
    metadata: meta,
  });
}

export function logApprovalExpired(
  actor: string,
  agentId: string,
  connectionId: string,
  meta: { approvalRequestId: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    connectionId,
    action: "approval_expired",
    decision: "denied",
    metadata: meta,
  });
}

// ── Agent Bootstrap (enrollment + re-keying) ──

export function logAgentBootstrapped(
  agentId: string,
  meta: { publicKeyThumbprint: string; previousStatus: string },
): AuditEventResult {
  return logEvent({
    actor: `agent:${agentId}`,
    agentId,
    action: "agent_bootstrapped",
    decision: "allowed",
    metadata: meta,
  });
}

export function logAgentBootstrapFailed(
  meta: { reason: string },
): AuditEventResult {
  return logEvent({
    actor: "system",
    action: "agent_bootstrap_failed",
    decision: "denied",
    metadata: meta,
  });
}

export function logAgentTokenIssued(
  agentId: string,
  meta: { tokenTtlSeconds: number },
): AuditEventResult {
  return logEvent({
    actor: `agent:${agentId}`,
    agentId,
    action: "agent_token_issued",
    decision: "allowed",
    metadata: meta,
  });
}

export function logAgentTokenDenied(
  agentId: string | null,
  meta: { reason: string },
): AuditEventResult {
  return logEvent({
    actor: agentId ? `agent:${agentId}` : "system",
    agentId,
    action: "agent_token_denied",
    decision: "denied",
    metadata: meta,
  });
}

export function logAgentDisabled(
  actor: string,
  agentId: string,
  meta: { tokensRevoked: number },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    action: "agent_disabled",
    decision: "allowed",
    metadata: meta,
  });
}

export function logAgentEnabled(
  actor: string,
  agentId: string,
  meta: { newStatus: string },
): AuditEventResult {
  return logEvent({
    actor,
    agentId,
    action: "agent_enabled",
    decision: "allowed",
    metadata: meta,
  });
}
