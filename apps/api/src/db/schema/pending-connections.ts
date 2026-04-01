import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { providerEnum, serviceEnum } from "./enums";
import { workspaces } from "./workspaces";

export const pendingConnections = pgTable("t_pending_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: providerEnum("provider").notNull(),
  service: serviceEnum("service").notNull(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** CSRF state parameter for auth code flow */
  state: text("state"),
  /** PKCE code verifier (stored server-side, never sent to client) */
  codeVerifier: text("code_verifier"),
  /** Requested scopes */
  scopes: text("scopes").array().notNull(),
  /** Label for the connection */
  label: text("label").notNull(),
  /** Additional flow metadata (e.g., redirect_uri) */
  metadata: jsonb("metadata"),
  /** When this pending connection expires */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
