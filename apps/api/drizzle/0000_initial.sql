DO $$ BEGIN CREATE TYPE "public"."agent_status" AS ENUM('created', 'active', 'disabled'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'denied', 'expired', 'consumed'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."audit_decision" AS ENUM('allowed', 'denied', 'error'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."connection_status" AS ENUM('healthy', 'needs_reauth', 'revoked'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."default_mode" AS ENUM('read_only', 'read_write', 'custom'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."execution_model" AS ENUM('A', 'B'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."policy_status" AS ENUM('active', 'revoked'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."provider_type" AS ENUM('google', 'microsoft', 'telegram', 'github', 'slack', 'anthropic', 'openai', 'gemini', 'openrouter', 'notion', 'trello', 'jira'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."service" AS ENUM('google-gmail', 'google-calendar', 'google-drive', 'google-sheets', 'google-docs', 'microsoft-teams', 'microsoft-outlook-mail', 'microsoft-outlook-calendar', 'microsoft-onedrive', 'microsoft-outlook-contacts', 'telegram', 'slack', 'anthropic-messages', 'openai', 'gemini', 'openrouter', 'notion', 'trello', 'jira'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "public"."step_up_approval" AS ENUM('always', 'risk_based', 'never'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "t_workspaces_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"id_token" text,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "t_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"image" text,
	"platform_role" text DEFAULT 'user' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "t_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider_type" NOT NULL,
	"service" "service" NOT NULL,
	"label" text NOT NULL,
	"status" "connection_status" DEFAULT 'healthy' NOT NULL,
	"workspace_id" uuid NOT NULL,
	"oauth_app_id" uuid,
	"encrypted_tokens" text,
	"granted_scopes" text[] NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon_url" text,
	"status" "agent_status" DEFAULT 'created' NOT NULL,
	"public_key_jwk" jsonb,
	"enrolled_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"action_template_id" text,
	"status" "policy_status" DEFAULT 'active' NOT NULL,
	"allowed_models" text[] NOT NULL,
	"default_mode" "default_mode" DEFAULT 'read_only' NOT NULL,
	"step_up_approval" "step_up_approval" DEFAULT 'risk_based' NOT NULL,
	"allowlists" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_limits" jsonb,
	"time_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{"request":[],"response":[]}'::jsonb NOT NULL,
	"provider_constraints" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "l_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"audit_id" uuid NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"agent_id" uuid,
	"connection_id" uuid,
	"action" text NOT NULL,
	"decision" "audit_decision" NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "l_audit_events_audit_id_unique" UNIQUE("audit_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_pending_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "provider_type" NOT NULL,
	"service" "service" NOT NULL,
	"workspace_id" uuid NOT NULL,
	"state" text,
	"code_verifier" text,
	"scopes" text[] NOT NULL,
	"label" text NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"request_details" jsonb NOT NULL,
	"quick_action_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_agent_permission_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_template_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"connection_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_personal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "t_personal_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link_url" text,
	"read" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_agent_bootstrap_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"secret_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_agent_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "t_agent_access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "l_jti_replay_cache" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_workspace_oauth_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "provider_type" NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"tenant_id" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "t_notification_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"connection_id" uuid,
	"config" jsonb NOT NULL,
	"verification_status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_notification_channels_workspace_type" UNIQUE("workspace_id","channel_type")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_accounts" ADD CONSTRAINT "t_accounts_user_id_t_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."t_users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_sessions" ADD CONSTRAINT "t_sessions_user_id_t_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."t_users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_connections" ADD CONSTRAINT "t_connections_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agents" ADD CONSTRAINT "t_agents_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_policies" ADD CONSTRAINT "t_policies_agent_id_t_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."t_agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_policies" ADD CONSTRAINT "t_policies_connection_id_t_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."t_connections"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_pending_connections" ADD CONSTRAINT "t_pending_connections_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_approval_requests" ADD CONSTRAINT "t_approval_requests_policy_id_t_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."t_policies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_approval_requests" ADD CONSTRAINT "t_approval_requests_agent_id_t_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."t_agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_approval_requests" ADD CONSTRAINT "t_approval_requests_connection_id_t_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."t_connections"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_permission_requests" ADD CONSTRAINT "t_agent_permission_requests_agent_id_t_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."t_agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_permission_requests" ADD CONSTRAINT "t_agent_permission_requests_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_permission_requests" ADD CONSTRAINT "t_agent_permission_requests_connection_id_t_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."t_connections"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_personal_access_tokens" ADD CONSTRAINT "t_personal_access_tokens_user_id_t_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."t_users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_personal_access_tokens" ADD CONSTRAINT "t_personal_access_tokens_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_notifications" ADD CONSTRAINT "t_notifications_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_bootstrap_secrets" ADD CONSTRAINT "t_agent_bootstrap_secrets_agent_id_t_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."t_agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_access_tokens" ADD CONSTRAINT "t_agent_access_tokens_agent_id_t_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."t_agents"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_agent_access_tokens" ADD CONSTRAINT "t_agent_access_tokens_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_workspace_oauth_apps" ADD CONSTRAINT "t_workspace_oauth_apps_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_notification_channels" ADD CONSTRAINT "t_notification_channels_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_notification_channels" ADD CONSTRAINT "t_notification_channels_connection_id_t_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."t_connections"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pat_token_hash" ON "t_personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pat_user_workspace" ON "t_personal_access_tokens" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bootstrap_secret_hash" ON "t_agent_bootstrap_secrets" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bootstrap_agent_type" ON "t_agent_bootstrap_secrets" USING btree ("agent_id","type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_token_hash" ON "t_agent_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_token_agent" ON "t_agent_access_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_token_expiry" ON "t_agent_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jti_expires_at" ON "l_jti_replay_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workspace_oauth_apps_workspace_provider" ON "t_workspace_oauth_apps" USING btree ("workspace_id","provider");
