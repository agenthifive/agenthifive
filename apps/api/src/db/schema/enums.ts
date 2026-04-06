import { pgEnum } from "drizzle-orm/pg-core";

export const connectionStatusEnum = pgEnum("connection_status", [
  "healthy",
  "needs_reauth",
  "revoked",
]);

export const providerEnum = pgEnum("provider_type", [
  "google",
  "microsoft",
  "telegram",
  "github",
  "slack",
  "anthropic",
  "openai",
  "gemini",
  "openrouter",
  "notion",
  "trello",
  "jira",
  "email",
]);

export const serviceEnum = pgEnum("service", [
  "google-gmail",
  "google-calendar",
  "google-drive",
  "google-sheets",
  "google-docs",
  "google-contacts",
  "microsoft-teams",
  "microsoft-outlook-mail",
  "microsoft-outlook-calendar",
  "microsoft-onedrive",
  "microsoft-outlook-contacts",
  "telegram",
  "slack",
  "anthropic-messages",
  "openai",
  "gemini",
  "openrouter",
  "notion",
  "trello",
  "jira",
  "email-imap",
]);

export const executionModelEnum = pgEnum("execution_model", ["A", "B"]);

export const defaultModeEnum = pgEnum("default_mode", [
  "read_only",
  "read_write",
  "custom",
]);

export const stepUpApprovalEnum = pgEnum("step_up_approval", [
  "always",
  "risk_based",
  "never",
]);

export const auditDecisionEnum = pgEnum("audit_decision", [
  "allowed",
  "denied",
  "error",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
]);

export const policyStatusEnum = pgEnum("policy_status", [
  "active",
  "revoked",
]);

export const agentStatusEnum = pgEnum("agent_status", [
  "created",
  "active",
  "disabled",
]);
