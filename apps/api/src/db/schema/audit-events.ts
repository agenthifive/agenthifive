import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { auditDecisionEnum } from "./enums";

export const auditEvents = pgTable("l_audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  auditId: uuid("audit_id").notNull().unique(),
  timestamp: timestamp("timestamp", { withTimezone: true })
    .notNull()
    .defaultNow(),
  actor: text("actor").notNull(),
  agentId: uuid("agent_id"),
  connectionId: uuid("connection_id"),
  action: text("action").notNull(),
  decision: auditDecisionEnum("decision").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
