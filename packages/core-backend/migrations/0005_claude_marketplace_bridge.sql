CREATE TABLE "claude_marketplace_bridge" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"public_key_pem" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "claude_marketplace_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "kind" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "claude_marketplace_codes" ADD CONSTRAINT "claude_marketplace_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claude_marketplace_codes_by_user" ON "claude_marketplace_codes" USING btree ("user_id");