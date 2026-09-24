CREATE TABLE "agent_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"key_id" uuid,
	"connection_id" uuid,
	"kind" text NOT NULL,
	"manual" text,
	"name" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer,
	"at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_kind" CHECK ("agent_events"."kind" IN ('capability', 'tool', 'skill')),
	CONSTRAINT "agent_events_outcome" CHECK ("agent_events"."outcome" IN ('ok', 'error', 'denied')),
	CONSTRAINT "agent_events_principal" CHECK (("agent_events"."key_id" IS NULL) <> ("agent_events"."connection_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_key_id_api_tokens_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_connection_id_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connections_by_user" ON "agent_connections" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connections_live_unq" ON "agent_connections" USING btree ("user_id","client_id") WHERE "agent_connections"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "agent_events_by_key" ON "agent_events" USING btree ("key_id","at");--> statement-breakpoint
CREATE INDEX "agent_events_by_connection" ON "agent_events" USING btree ("connection_id","at");--> statement-breakpoint
CREATE INDEX "agent_events_by_at" ON "agent_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "agent_events_by_user" ON "agent_events" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_connection_id_agent_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_tokens_by_connection" ON "oauth_tokens" USING btree ("connection_id");