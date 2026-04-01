import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { workspaces } from "./workspaces";

export const agentAccessTokens = pgTable(
  "t_agent_access_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_agent_token_hash").on(table.tokenHash),
    index("idx_agent_token_agent").on(table.agentId),
    index("idx_agent_token_expiry").on(table.expiresAt),
  ],
);
