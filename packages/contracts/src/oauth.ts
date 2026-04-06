import { z } from "zod";
import { ScopeSchema } from "./common.js";

/**
 * Supported OAuth Providers
 */
export const OAuthProviderSchema = z.enum([
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
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

/**
 * OAuth Token Set (provider tokens)
 */
export const OAuthTokenSetSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string().default("Bearer"),
  expiresAt: z.number().int().optional(),
  scope: z.array(ScopeSchema).optional(),
});
export type OAuthTokenSet = z.infer<typeof OAuthTokenSetSchema>;
