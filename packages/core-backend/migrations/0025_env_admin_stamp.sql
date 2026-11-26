-- Which ADMIN_PASSWORD the deployment admin's current session generation
-- belongs to (an HMAC keyed with the JWT secret, never the password). Each
-- boot compares it with the current password and moves session_version on
-- when they differ, so rotating ADMIN_PASSWORD ends the sessions opened with
-- the old one. NULL everywhere at first, so the first boot of this version
-- moves the deployment admin's generation on once, and it signs in again.
-- Guarded so a database that already has the column no-ops instead of failing.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "env_admin_stamp" text;
