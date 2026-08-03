-- The one onboarding fact the server keeps: has this user concluded the
-- connect-your-agent setup (welcome page Done, or the reminder pill's
-- dismiss). Hand-written in the same idempotent style as 0001: IF NOT EXISTS,
-- so a re-run — or a database that already has the column — no-ops instead of
-- failing.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "onboarding_done" boolean DEFAULT false NOT NULL;