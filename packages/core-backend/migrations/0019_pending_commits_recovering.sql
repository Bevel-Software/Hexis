-- A queued commit handed to the recovery agent is `recovering` for as long as
-- the agent runs: no worker pass claims it, and the merge the agent makes to
-- rescue it (`update_branch`) does not wait for it. The worker returns it to
-- `pending` when the agent returns, and the boot-time reset does after a
-- restart mid-run.
ALTER TABLE "pending_commits" DROP CONSTRAINT "pending_commits_status";--> statement-breakpoint
ALTER TABLE "pending_commits" ADD CONSTRAINT "pending_commits_status" CHECK ("pending_commits"."status" IN ('pending', 'running', 'recovering', 'needs_attention'));