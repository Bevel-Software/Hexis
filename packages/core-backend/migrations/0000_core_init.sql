-- Squashed idempotent CORE init (hand-edited after `drizzle-kit generate`).
-- Runs safely against BOTH a fresh database (bootstraps everything) and a
-- database that predates the core/enterprise split (every object already
-- exists -> each statement no-ops):
--   * CREATE TABLE IF NOT EXISTS  - skipped when the legacy table exists
--   * CREATE [UNIQUE] INDEX IF NOT EXISTS
--   * ADD CONSTRAINT wrapped in a pg_catalog-guarded DO block (Postgres has
--     no IF NOT EXISTS for ALTER TABLE .. ADD CONSTRAINT)
CREATE TABLE IF NOT EXISTS "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "change_requests_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"source_branch" text NOT NULL,
	"target_branch" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"merged_sha" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp,
	"closed_at" timestamp,
	CONSTRAINT "change_requests_state_check" CHECK ("change_requests"."state" IN ('open', 'merged', 'closed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_locks" (
	"workspace_id" text NOT NULL,
	"branch" text NOT NULL,
	"path" text NOT NULL,
	"holder_user_id" uuid NOT NULL,
	"holder_name" text NOT NULL,
	"acquired_at" timestamp DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "file_locks_workspace_id_branch_path_pk" PRIMARY KEY("workspace_id","branch","path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" text,
	"resource" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_auth_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"client_secret_encrypted" text,
	"client_secret_expires_at" timestamp,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"access_token_hash" text NOT NULL,
	"refresh_token_hash" text,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" text,
	"resource" text,
	"expires_at" timestamp NOT NULL,
	"refresh_expires_at" timestamp,
	"revoked_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_access_token_hash_unique" UNIQUE("access_token_hash"),
	CONSTRAINT "oauth_tokens_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"branch" text NOT NULL,
	"path" text NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text NOT NULL,
	"queued_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"recovery_agent_runs" integer DEFAULT 0 NOT NULL,
	"last_attempted_at" timestamp,
	"last_error" text,
	CONSTRAINT "pending_commits_status" CHECK ("pending_commits"."status" IN ('pending', 'running', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_number" integer NOT NULL,
	"author_email" text NOT NULL,
	"author_name" text NOT NULL,
	"path" text,
	"line" integer,
	"head_sha" text NOT NULL,
	"body" text NOT NULL,
	"parent_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_file_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_number" integer NOT NULL,
	"path" text NOT NULL,
	"approver_email" text NOT NULL,
	"approver_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"approved_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pr_merge_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_number" integer NOT NULL,
	"triggered_by_email" text NOT NULL,
	"triggered_by_name" text NOT NULL,
	"head_sha_at_merge" text NOT NULL,
	"merge_method" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"key" text NOT NULL,
	"kind" text DEFAULT 'static' NOT NULL,
	"label" text,
	"value_encrypted" text NOT NULL,
	"oauth_meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_ontology_touches" (
	"session_id" text NOT NULL,
	"ontology" text NOT NULL,
	"touched_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_ontology_touches_session_id_ontology_pk" PRIMARY KEY("session_id","ontology")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'api_tokens_user_id_users_id_fk' AND conrelid = 'public.api_tokens'::regclass
	) THEN
		ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'file_locks_holder_user_id_users_id_fk' AND conrelid = 'public.file_locks'::regclass
	) THEN
		ALTER TABLE "file_locks" ADD CONSTRAINT "file_locks_holder_user_id_users_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'oauth_auth_codes_client_id_oauth_clients_client_id_fk' AND conrelid = 'public.oauth_auth_codes'::regclass
	) THEN
		ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'oauth_auth_codes_user_id_users_id_fk' AND conrelid = 'public.oauth_auth_codes'::regclass
	) THEN
		ALTER TABLE "oauth_auth_codes" ADD CONSTRAINT "oauth_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'oauth_tokens_client_id_oauth_clients_client_id_fk' AND conrelid = 'public.oauth_tokens'::regclass
	) THEN
		ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'oauth_tokens_user_id_users_id_fk' AND conrelid = 'public.oauth_tokens'::regclass
	) THEN
		ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'secrets_user_id_users_id_fk' AND conrelid = 'public.secrets'::regclass
	) THEN
		ALTER TABLE "secrets" ADD CONSTRAINT "secrets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_number_unq" ON "change_requests" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "change_requests_open_pair_unq" ON "change_requests" USING btree ("source_branch","target_branch") WHERE "change_requests"."state" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_requests_by_state" ON "change_requests" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_tokens_by_user" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_locks_by_expiry" ON "file_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_locks_by_holder" ON "file_locks" USING btree ("holder_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_auth_codes_by_expiry" ON "oauth_auth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_by_user" ON "oauth_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_by_expiry" ON "oauth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_commits_by_workspace_queued" ON "pending_commits" USING btree ("workspace_id","queued_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_commits_by_status" ON "pending_commits" USING btree ("status","last_attempted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_commits_by_status_only" ON "pending_commits" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_comments_by_pr" ON "pr_comments" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_comments_by_thread" ON "pr_comments" USING btree ("pr_number","path","line");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pr_file_approvals_unq" ON "pr_file_approvals" USING btree ("pr_number","path","approver_email","head_sha");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_file_approvals_by_pr" ON "pr_file_approvals" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_merge_log_by_pr" ON "pr_merge_log" USING btree ("pr_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_by_user" ON "secrets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_user_key_unq" ON "secrets" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_shared_key_unq" ON "secrets" USING btree ("key") WHERE "secrets"."user_id" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_ontology_touches_by_touched_at" ON "session_ontology_touches" USING btree ("touched_at");