import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * l_jti_replay_cache — append-only log of used JWT IDs for replay protection.
 * Primary key on `jti` ensures atomicity across replicas.
 * Expired rows cleaned up every 5 minutes.
 */
export const jtiReplayCache = pgTable(
  "l_jti_replay_cache",
  {
    jti: text("jti").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("idx_jti_expires_at").on(table.expiresAt)],
);
