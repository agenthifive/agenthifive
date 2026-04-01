CREATE TABLE IF NOT EXISTS "t_push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expo_push_token" text NOT NULL,
	"platform" text NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_push_sub_token" UNIQUE("expo_push_token")
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_push_subscriptions" ADD CONSTRAINT "t_push_subscriptions_user_id_t_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."t_users"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "t_push_subscriptions" ADD CONSTRAINT "t_push_subscriptions_workspace_id_t_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."t_workspaces"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN null; END $$;
