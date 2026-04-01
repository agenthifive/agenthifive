import { z } from "zod";

/**
 * Credential kind — what type of credential is being requested.
 * Used by OpenClaw fork's VaultCredentialProvider to categorize lookups.
 */
export const CredentialKindSchema = z.enum([
  "model_provider",
  "channel",
  "plugin_config",
]);
export type CredentialKind = z.infer<typeof CredentialKindSchema>;

/**
 * Credential auth mode — how the credential authenticates.
 */
export const CredentialModeSchema = z.enum([
  "api-key",
  "oauth",
  "token",
  "aws-sdk",
]);
export type CredentialMode = z.infer<typeof CredentialModeSchema>;

/**
 * POST /credentials/resolve — Request
 *
 * Sent by the OpenClaw fork's VaultCredentialProvider to resolve
 * a credential from the AgentHiFive vault.
 */
export const CredentialResolveRequestSchema = z.object({
  kind: CredentialKindSchema,
  /** Provider/channel identifier (e.g., "openai", "telegram", "slack") */
  provider: z.string().min(1),
  /** Optional account/profile ID for multi-account setups */
  profileId: z.string().optional(),
  /** Optional hint about which config fields are needed */
  fields: z.array(z.string()).optional(),
});
export type CredentialResolveRequest = z.infer<typeof CredentialResolveRequestSchema>;

/**
 * POST /credentials/resolve — Response (200)
 *
 * Returns the resolved credential. The OpenClaw fork caches this
 * locally based on cacheTtlMs.
 */
export const CredentialResolveResponseSchema = z.object({
  /** The primary credential value (API key, access token, bot token) */
  apiKey: z.string().min(1),
  /** Additional fields for multi-field credentials (e.g., Slack appToken, Teams tenantId) */
  extra: z.record(z.string(), z.string()).optional(),
  /** Source description for audit/debugging */
  source: z.string().min(1),
  /** Auth mode classification */
  mode: CredentialModeSchema.optional(),
  /** How long the caller can cache this credential locally (ms) */
  cacheTtlMs: z.number().int().positive().optional(),
});
export type CredentialResolveResponse = z.infer<typeof CredentialResolveResponseSchema>;
