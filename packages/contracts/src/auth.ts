import { z } from "zod";
import { ScopeSchema, WorkspaceRoleSchema } from "./common.js";

/**
 * Internal API JWT Claims
 * Issued by apps/web, verified by apps/api
 */
export const ApiAccessClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.literal("api"),
  sub: z.string().min(1),
  sid: z.string().min(1),
  wid: z.string().min(1),
  roles: z.array(WorkspaceRoleSchema),
  scp: z.array(ScopeSchema),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1),
});
export type ApiAccessClaims = z.infer<typeof ApiAccessClaimsSchema>;

/**
 * Token Exchange Request
 * POST /api/internal/token/exchange
 */
export const TokenExchangeRequestSchema = z.object({
  workspaceId: z.string().min(1),
  requestedScopes: z.array(ScopeSchema).default([]),
});
export type TokenExchangeRequest = z.infer<typeof TokenExchangeRequestSchema>;

/**
 * Token Exchange Response
 */
export const TokenExchangeResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
});
export type TokenExchangeResponse = z.infer<typeof TokenExchangeResponseSchema>;
