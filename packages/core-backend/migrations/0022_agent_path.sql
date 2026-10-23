-- Connecting as an agent: the `.agent` file a connection was made as, by its
-- repo-relative knowledge-base path. Null is Everything — every row that
-- exists today, which therefore keeps exactly the surface it had. Chosen on
-- the OAuth consent step (carried on the auth code to the token exchange,
-- which records it on the agent connection) or when a connection key is
-- minted. The path is the whole record: the file itself is re-read on every
-- surface build (see `modules/agent-scope`).
ALTER TABLE "agent_connections" ADD COLUMN "agent_path" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "agent_path" text;--> statement-breakpoint
ALTER TABLE "oauth_auth_codes" ADD COLUMN "agent_path" text;
