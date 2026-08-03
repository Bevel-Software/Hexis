-- The one onboarding fact the server keeps: has this user concluded the
-- connect-your-agent setup (welcome page Done, or the reminder pill's ×).
--
-- Wrapped in a DO block rather than written as `ADD COLUMN IF NOT EXISTS`,
-- because the backfill and the add must be ONE decision. Everyone who already
-- has an account predates this feature: greeting them with "Welcome, <name>"
-- and nagging them to connect an agent they may have been using for months is
-- wrong, so they are grandfathered to true and only accounts created after
-- this migration get the onboarding.
--
-- The guard is what makes that safe to re-run. A bare `UPDATE users SET
-- onboarding_done = true` after an `IF NOT EXISTS` add would, on a second run,
-- silently conclude the onboarding of every genuinely-new user who had not
-- finished it. Inside the block the UPDATE only ever executes on the run that
-- creates the column.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'onboarding_done'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "onboarding_done" boolean DEFAULT false NOT NULL;
    UPDATE "users" SET "onboarding_done" = true;
  END IF;
END $$;