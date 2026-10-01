-- The claim on a join request: WHEN it was taken, and BY WHICH attempt.
--
-- These two arrived after `0010_plugin_join_requests` was already written, and
-- they belong in their own numbered file rather than edited into it. Drizzle
-- tracks what it has applied by the migration's tag, so a database that has
-- already run `0010` would skip an amended `0010` forever — and every claim,
-- heartbeat and record query would then fail against a table missing both
-- columns. `IF NOT EXISTS` covers the other direction, a database built from a
-- head where `0010` did carry `claimed_at`.
ALTER TABLE "plugin_join_requests" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;--> statement-breakpoint
ALTER TABLE "plugin_join_requests" ADD COLUMN IF NOT EXISTS "claim_token" uuid;
