import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

export const notifications = pgTable("t_notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Notification type: permission_request, connection_issue, approval_resolved, etc. */
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** URL to navigate to when clicked (e.g., /dashboard/approvals) */
  linkUrl: text("link_url"),
  read: boolean("read").notNull().default(false),
  /** Additional structured data */
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
