-- Columns added to Drizzle schema after 0000_initial was already applied on Azure.
-- CREATE TABLE IF NOT EXISTS skipped them because t_users/t_accounts already existed.
ALTER TABLE "t_users" ADD COLUMN IF NOT EXISTS "platform_role" text DEFAULT 'user' NOT NULL;
ALTER TABLE "t_users" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp with time zone;
ALTER TABLE "t_accounts" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp with time zone;
