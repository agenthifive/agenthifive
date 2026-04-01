import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const promptHistoryQuarantines = pgTable("t_prompt_history_quarantines", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  sessionKey: text("session_key").notNull(),
  approvalRequestId: uuid("approval_request_id").notNull(),
  resolution: text("resolution").notNull(),
  fragments: jsonb("fragments").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  approvalRequestIdUnique: uniqueIndex("t_prompt_history_quarantines_approval_request_id_idx").on(table.approvalRequestId),
}));
