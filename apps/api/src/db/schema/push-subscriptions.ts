import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";

/**
 * Push subscriptions — stores Expo push tokens per user/device.
 * Unlike notification channels (one per workspace per type), push subscriptions
 * are per-device: a user may have multiple phones/tablets.
 */
export const pushSubscriptions = pgTable(
  "t_push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform").notNull(), // "ios" | "android"
    deviceName: text("device_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_push_sub_token").on(t.expoPushToken),
  ],
);
