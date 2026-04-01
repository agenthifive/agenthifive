ALTER TYPE "public"."service" ADD VALUE 'google-contacts' BEFORE 'microsoft-teams';--> statement-breakpoint
ALTER TABLE "t_policies" ADD COLUMN "security_preset" text;--> statement-breakpoint
ALTER TABLE "t_approval_requests" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "t_approval_requests" ADD COLUMN "telegram_message_id" integer;--> statement-breakpoint
ALTER TABLE "t_approval_requests" ADD COLUMN "telegram_chat_id" text;