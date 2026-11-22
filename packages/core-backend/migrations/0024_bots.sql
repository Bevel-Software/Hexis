ALTER TABLE "agent_connections" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "bot_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_retired_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_bot_user_id_users_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_bot_id_unq" ON "users" USING btree ("bot_id");