ALTER TABLE "change_requests" ADD COLUMN "apply_failure_kind" text;--> statement-breakpoint
-- Backfill refusals recorded under 0008, which had no kind: without one, an
-- approval (which clears only 'gate') would leave an old gate refusal stuck
-- until the source branch moves. 0008 stored git conflicts with
-- apply_failure_conflicts = true and the merge gate's refusal with its own
-- message, which always starts "Merge gate rejected:"; anything else is 'error'.
UPDATE "change_requests"
SET "apply_failure_kind" = CASE
  WHEN "apply_failure_conflicts" = true THEN 'conflicts'
  WHEN "apply_failure_reason" LIKE 'Merge gate rejected:%' THEN 'gate'
  ELSE 'error'
END
WHERE "apply_failed_at" IS NOT NULL AND "apply_failure_kind" IS NULL;
