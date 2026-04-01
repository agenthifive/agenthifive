import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { agentStatusEnum } from "./enums";
import { workspaces } from "./workspaces";

export const agents = pgTable("t_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  iconUrl: text("icon_url"),
  status: agentStatusEnum("status").notNull().default("created"),
  /** ES256 public key in JWK format, set during enrollment */
  publicKeyJwk: jsonb("public_key_jwk"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
