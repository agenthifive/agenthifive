CREATE TABLE "t_prompt_history_quarantines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_key" text NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"resolution" text NOT NULL,
	"fragments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "t_prompt_history_quarantines_approval_request_id_idx" ON "t_prompt_history_quarantines" USING btree ("approval_request_id");