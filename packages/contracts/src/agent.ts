import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

export const AgentStatusSchema = z.enum(["created", "active", "disabled"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  status: AgentStatusSchema,
  workspaceId: z.string().min(1),
  enrolledAt: ISODateTimeSchema.nullable(),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
});
export type Agent = z.infer<typeof AgentSchema>;
