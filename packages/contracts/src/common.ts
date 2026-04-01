import { z } from "zod";

// Branded types for type safety
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type AgentId = Brand<string, "AgentId">;
export type PolicyId = Brand<string, "PolicyId">;
export type AuditId = Brand<string, "AuditId">;

// Common schemas
export const ISODateTimeSchema = z.string().datetime({ offset: true });
export type ISODateTime = z.infer<typeof ISODateTimeSchema>;

export const ScopeSchema = z.string().min(1);
export type Scope = z.infer<typeof ScopeSchema>;

export const WorkspaceRoleSchema = z.enum([
  "owner",
  "admin",
  "member",
  "viewer",
  "agent",
]);
export type WorkspaceRole = z.infer<typeof WorkspaceRoleSchema>;

export const PlatformRoleSchema = z.enum(["user", "superadmin"]);
export type PlatformRole = z.infer<typeof PlatformRoleSchema>;
