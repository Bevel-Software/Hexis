-- An account an admin switched off keeps its row; NULL is "on". Guarded so a
-- database that already has the column no-ops instead of failing.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp;
