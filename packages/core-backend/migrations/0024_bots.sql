ALTER TABLE "agent_connections" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "made_by_email" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "made_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "made_by_name" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "pending_commits" ADD COLUMN "made_by_email" text;--> statement-breakpoint
ALTER TABLE "pending_commits" ADD COLUMN "made_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pending_commits" ADD COLUMN "made_by_name" text;--> statement-breakpoint
ALTER TABLE "pr_file_approvals" ADD COLUMN "made_by_email" text;--> statement-breakpoint
ALTER TABLE "pr_file_approvals" ADD COLUMN "made_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_file_approvals" ADD COLUMN "made_by_name" text;--> statement-breakpoint
ALTER TABLE "pr_merge_log" ADD COLUMN "made_by_email" text;--> statement-breakpoint
ALTER TABLE "pr_merge_log" ADD COLUMN "made_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_merge_log" ADD COLUMN "made_by_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connections_by_bot" ON "agent_connections" USING btree ("bot_user_id");--> statement-breakpoint
CREATE INDEX "agent_events_by_bot" ON "agent_events" USING btree ("bot_user_id");--> statement-breakpoint
CREATE INDEX "api_tokens_by_bot" ON "api_tokens" USING btree ("bot_user_id");--> statement-breakpoint
CREATE INDEX "oauth_auth_codes_by_bot" ON "oauth_auth_codes" USING btree ("bot_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_bot_id_unq" ON "users" USING btree ("bot_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bot_retired_only_bots" CHECK ("users"."bot_retired_at" IS NULL OR "users"."bot_id" IS NOT NULL);