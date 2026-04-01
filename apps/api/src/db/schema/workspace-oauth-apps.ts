import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { providerEnum } from "./enums";
import { workspaces } from "./workspaces";

/**
 * Per-workspace OAuth app credentials (BYA — Bring Your App).
 * Lets each workspace register their own Google/Microsoft OAuth app
 * when corporate credentials are not configured via env vars.
 *
 * One app per (workspace, provider). The client_id is plaintext (public value),
 * while the client_secret is encrypted with AES-256-GCM.
 */
export const workspaceOauthApps = pgTable(
  "t_workspace_oauth_apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    /** OAuth client ID — public value, stored in plaintext */
    clientId: text("client_id").notNull(),
    /** Encrypted client secret (AES-256-GCM JSON payload) */
    encryptedClientSecret: text("encrypted_client_secret").notNull(),
    /** Microsoft-only: Azure AD tenant ID (null defaults to "common") */
    tenantId: text("tenant_id"),
    /** Human-readable label for the dashboard */
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_workspace_oauth_apps_workspace_provider").on(
      table.workspaceId,
      table.provider,
    ),
  ],
);
