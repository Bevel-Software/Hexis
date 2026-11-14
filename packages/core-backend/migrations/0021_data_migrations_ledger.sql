-- The ledger of the DATA halves of migrations: the rewrites SQL cannot do
-- because they read sealed columns, run by the application right after the
-- SQL history under the same lock. One row per pass, written in the SAME
-- transaction as the rows it rewrote, so a pass is recorded done exactly when
-- its work is; a start that crashed between drizzle's own ledger and the pass
-- leaves no row, and the next start runs it. First used by 0020's body move.
CREATE TABLE "data_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL,
	"note" text
);
