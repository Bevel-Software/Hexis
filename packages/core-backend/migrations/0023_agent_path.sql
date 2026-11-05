ALTER TABLE "agent_connections" ADD COLUMN "agent_path" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "agent_path" text;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "agent_path" text;