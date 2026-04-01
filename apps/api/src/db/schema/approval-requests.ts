import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { approvalStatusEnum } from "./enums";
import { agents } from "./agents";
import { connections } from "./connections";
import { policies } from "./policies";

export const approvalRequests = pgTable("t_approval_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The policy that triggered this approval */
  policyId: uuid("policy_id")
    .notNull()
    .references(() => policies.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  /** The workspace this approval belongs to (for scoped queries) */
  workspaceId: uuid("workspace_id").notNull(),
  /** Who initiated the request (userId or agentId) */
  actor: text("actor").notNull(),
  /** Current status */
  status: approvalStatusEnum("status").notNull().default("pending"),
  /** The original Model B request details */
  requestDetails: jsonb("request_details").notNull(),
  /** Why this approval was required (rule label or legacy reason) */
  reason: text("reason"),
  /** Random token for quick approve/deny via URL (Telegram inline buttons). Null = no external notification sent. */
  quickActionToken: text("quick_action_token"),
  /** Telegram message ID of the approval notification (for editing the message after resolution). */
  telegramMessageId: integer("telegram_message_id"),
  /** Telegram chat ID where the notification was sent (for editing the message after resolution). */
  telegramChatId: text("telegram_chat_id"),
  /** When this approval expires */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
