-- Per-user password login: scrypt hash column (NULL = SSO-only account).
-- Idempotent like the init — a database that somehow already carries the
-- column (e.g. a re-run after a partial failure) no-ops.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
