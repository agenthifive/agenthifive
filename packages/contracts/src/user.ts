import { z } from "zod";
import { ISODateTimeSchema } from "./common.js";

export const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  workspaceId: z.string().min(1),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;
