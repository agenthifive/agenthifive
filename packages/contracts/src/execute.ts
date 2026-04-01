import { z } from "zod";
import { ExecutionModelSchema } from "./policy.js";

/**
 * Execute Request — Model A (token vending)
 */
export const ExecuteRequestModelASchema = z.object({
  model: z.literal("A"),
  connectionId: z.string().min(1),
});
export type ExecuteRequestModelA = z.infer<typeof ExecuteRequestModelASchema>;

/**
 * Execute Request — Model B (brokered proxy)
 */
export const ExecuteRequestModelBSchema = z.object({
  model: z.literal("B"),
  connectionId: z.string().min(1),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  url: z.string().url(),
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});
export type ExecuteRequestModelB = z.infer<typeof ExecuteRequestModelBSchema>;

/**
 * Unified Execute Request (discriminated union)
 */
export const ExecuteRequestSchema = z.discriminatedUnion("model", [
  ExecuteRequestModelASchema,
  ExecuteRequestModelBSchema,
]);
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;

/**
 * Execute Response — Model A (token vending)
 */
export const ExecuteResponseModelASchema = z.object({
  model: z.literal("A"),
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
  auditId: z.string().uuid(),
});
export type ExecuteResponseModelA = z.infer<typeof ExecuteResponseModelASchema>;

/**
 * Execute Response — Model B (brokered proxy)
 */
export const ExecuteResponseModelBSchema = z.object({
  model: z.literal("B"),
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
  auditId: z.string().uuid(),
});
export type ExecuteResponseModelB = z.infer<typeof ExecuteResponseModelBSchema>;

/**
 * Execute Response — Approval Required
 */
export const ExecuteResponseApprovalSchema = z.object({
  approvalRequired: z.literal(true),
  approvalRequestId: z.string().min(1),
  auditId: z.string().uuid(),
});
export type ExecuteResponseApproval = z.infer<typeof ExecuteResponseApprovalSchema>;

/**
 * Unified Execute Response
 */
export const ExecuteResponseSchema = z.union([
  ExecuteResponseModelASchema,
  ExecuteResponseModelBSchema,
  ExecuteResponseApprovalSchema,
]);
export type ExecuteResponse = z.infer<typeof ExecuteResponseSchema>;
