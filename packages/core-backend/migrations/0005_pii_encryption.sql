-- PII column encryption: add the blind-index companion columns, NULLABLE and
-- unconstrained. The columns are populated — and existing plaintext PII rows
-- rewritten to AES-256-GCM ciphertext — by the programmatic backfill that runs
-- right after the SQL migrations on every boot (`runPiiEncryptionBackfill` in
-- migrate.ts). That same step then applies SET NOT NULL and swaps the unique
-- constraints (`users_email_unique` → `users_email_bidx_unq`,
-- `pr_file_approvals_unq` → `pr_file_approvals_bidx_unq`), because a unique
-- index on a blind-index column can only go up once every row has one.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_file_approvals" ADD COLUMN IF NOT EXISTS "approver_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_merge_log" ADD COLUMN IF NOT EXISTS "triggered_by_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pr_comments" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;--> statement-breakpoint
ALTER TABLE "pending_commits" ADD COLUMN IF NOT EXISTS "author_email_bidx" text;
