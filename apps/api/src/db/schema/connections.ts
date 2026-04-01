import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { connectionStatusEnum, providerEnum, serviceEnum } from "./enums";
import { workspaces } from "./workspaces";

export const connections = pgTable("t_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: providerEnum("provider").notNull(),
  service: serviceEnum("service").notNull(),
  label: text("label").notNull(),
  status: connectionStatusEnum("status").notNull().default("healthy"),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /**
   * FK to the BYA OAuth app used to create this connection.
   * null = corporate env-var credentials.
   * FK constraint (SET NULL on delete) applied via drizzle-kit push.
   */
  oauthAppId: uuid("oauth_app_id"),
  encryptedTokens: text("encrypted_tokens"),
  grantedScopes: text("granted_scopes").array().notNull(),
  /** Provider-specific metadata (e.g., Telegram bot info, Microsoft tenant/profile) */
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
