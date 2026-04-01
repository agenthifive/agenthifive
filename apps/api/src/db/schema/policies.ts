import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { defaultModeEnum, stepUpApprovalEnum, policyStatusEnum } from "./enums";
import { agents } from "./agents";
import { connections } from "./connections";

export const policies = pgTable("t_policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  actionTemplateId: text("action_template_id"),
  securityPreset: text("security_preset"),
  status: policyStatusEnum("status").notNull().default("active"),
  allowedModels: text("allowed_models").array().notNull(),
  defaultMode: defaultModeEnum("default_mode").notNull().default("read_only"),
  stepUpApproval: stepUpApprovalEnum("step_up_approval")
    .notNull()
    .default("risk_based"),
  allowlists: jsonb("allowlists").notNull().default([]),
  rateLimits: jsonb("rate_limits"),
  timeWindows: jsonb("time_windows").notNull().default([]),
  rules: jsonb("rules").notNull().default({ request: [], response: [] }),
  providerConstraints: jsonb("provider_constraints"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
