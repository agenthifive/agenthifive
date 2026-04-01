import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { agents } from "./agents";

export const agentBootstrapSecrets = pgTable(
  "t_agent_bootstrap_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** "enrollment" or "reattach" */
    type: text("type").notNull(),
    secretHash: text("secret_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_bootstrap_secret_hash").on(table.secretHash),
    index("idx_bootstrap_agent_type").on(table.agentId, table.type),
  ],
);
