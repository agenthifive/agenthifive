import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { workspaces } from "./workspaces";
import { connections } from "./connections";
import { approvalStatusEnum } from "./enums";

/**
 * Agent-initiated requests for permission to access user resources.
 * These are shown in the Approvals UI for users to review and grant access.
 */
export const agentPermissionRequests = pgTable("t_agent_permission_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Action template ID (e.g., "gmail-read", "calendar-manage") */
  actionTemplateId: text("action_template_id").notNull(),
  /** Agent's explanation for why it needs this permission */
  reason: text("reason").notNull(),
  /** Request status: pending → approved/denied */
  status: approvalStatusEnum("status").notNull().default("pending"),
  /** Connection created when approved (null until approved) */
  connectionId: uuid("connection_id").references(() => connections.id, { onDelete: "set null" }),
  /** When the request was approved or denied */
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  /** When the request was created */
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
