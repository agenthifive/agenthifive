import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

export const AuditDecisionSchema = z.enum([
  "allowed",
  "denied",
  "error",
]);
export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  auditId: z.string().uuid(),
  timestamp: ISODateTimeSchema,
  actor: z.string().min(1),
  agentId: z.string().min(1).nullable(),
  connectionId: z.string().min(1).nullable(),
  action: z.string().min(1),
  decision: AuditDecisionSchema,
  metadata: z.record(z.string(), z.unknown()),
  createdAt: ISODateTimeSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
