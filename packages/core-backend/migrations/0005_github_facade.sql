CREATE TABLE "github_facade_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_facade_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "github_facade_identity" (
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
ALTER TABLE "api_tokens" ADD COLUMN "kind" text DEFAULT 'key' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_facade_codes" ADD CONSTRAINT "github_facade_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;