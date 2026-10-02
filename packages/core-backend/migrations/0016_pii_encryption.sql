-- PII column encryption: add the blind-index companion columns, NULLABLE and
-- unconstrained. The columns are populated — and existing plaintext PII rows
-- rewritten to AES-256-GCM ciphertext — by the programmatic backfill that runs
-- right after the SQL history on every start, under the same lock
-- (`runPiiEncryptionBackfill` in migrate.ts). That same step then applies SET
-- NOT NULL and swaps the unique constraints (`users_email_unique` →
-- `users_email_bidx_unq`, `pr_file_approvals_unq` → `pr_file_approvals_bidx_unq`,
-- `plugin_join_requests_requester_plugin_unq` →
-- `plugin_join_requests_requester_bidx_plugin_unq`), because a unique index on
-- a blind-index column can only go up once every row has one. The snapshot
-- beside this file describes the END state, which is what the next migration
-- is generated against.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_file_approvals" ADD COLUMN IF NOT EXISTS "approver_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_merge_log" ADD COLUMN IF NOT EXISTS "triggered_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_comments" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "apply_failed_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pending_commits" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;--> statement-breakpoint
ALTER TABLE "plugin_join_requests" ADD COLUMN IF NOT EXISTS "requester_email_bidx" text;
