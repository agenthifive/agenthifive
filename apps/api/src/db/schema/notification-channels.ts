import { boolean, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { connections } from "./connections";

/**
 * Notification channels — stores workspace notification delivery preferences.
 * Extensible: channelType discriminates between telegram, email, slack, etc.
 * One channel per workspace per channelType (unique constraint).
 */
export const notificationChannels = pgTable(
  "t_notification_channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Channel type discriminator: "telegram" for now, extensible to "email", "slack", etc. */
    channelType: text("channel_type").notNull(),
    /** Whether this channel is enabled for delivery */
    enabled: boolean("enabled").notNull().default(true),
    /** FK to the connection used for delivery (e.g., Telegram bot connection) */
    connectionId: uuid("connection_id")
      .references(() => connections.id, { onDelete: "set null" }),
    /** Channel-specific config: { chatId } for Telegram, { email } for email, etc. */
    config: jsonb("config").notNull(),
    /** Verification status: "pending" or "verified" */
    verificationStatus: text("verification_status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_notification_channels_workspace_type").on(t.workspaceId, t.channelType),
  ],
);
