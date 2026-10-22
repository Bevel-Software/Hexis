-- The generation of an account's sessions that is honoured: a session token
-- carries the value it was issued at, and changing the password moves it on.
-- Every existing row starts at 0, which is what a token issued before this
-- column existed counts as, so nobody is signed out by the upgrade. Guarded
-- so a database that already has the column no-ops instead of failing.
ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;