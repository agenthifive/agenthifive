import { z } from "zod";
import { ISODateTimeSchema, ScopeSchema } from "./common.js";
import { OAuthProviderSchema } from "./oauth.js";
import { SERVICE_IDS } from "./services.js";

export const ServiceIdSchema = z.enum(SERVICE_IDS);

export const ConnectionStatusSchema = z.enum([
  "healthy",
  "needs_reauth",
  "revoked",
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionSchema = z.object({
  id: z.string().min(1),
  provider: OAuthProviderSchema,
  service: ServiceIdSchema,
  label: z.string().min(1),
  status: ConnectionStatusSchema,
  workspaceId: z.string().min(1),
  encryptedTokens: z.string().min(1),
  grantedScopes: z.array(ScopeSchema),
  createdAt: ISODateTimeSchema,
  updatedAt: ISODateTimeSchema,
});
export type Connection = z.infer<typeof ConnectionSchema>;
