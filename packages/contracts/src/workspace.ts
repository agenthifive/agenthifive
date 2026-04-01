import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ownerId: z.string().min(1),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
