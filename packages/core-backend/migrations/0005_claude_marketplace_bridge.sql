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
