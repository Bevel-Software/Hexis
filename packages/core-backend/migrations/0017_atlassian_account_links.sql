-- The account-link table the embed surface resolves an outside identity with.
--
-- CREATE TABLE IF NOT EXISTS, and the foreign key behind an existence guard,
-- because an ENTERPRISE DATABASE ALREADY HAS THIS TABLE: it was created by the
-- Bevel Platform's own migration history, under this exact name and shape,
-- while the embed lived there. Such a database must be ADOPTED as it stands —
-- every Atlassian account link it holds keeps working, and nobody re-links
-- after the upgrade. On a database that has never seen it, these statements
-- create it from scratch.
CREATE TABLE IF NOT EXISTS "atlassian_account_links" (
	"atlassian_account_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Same constraint NAME the enterprise history used, so the guard recognises
-- the one an upgraded database already carries and adds nothing.
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'atlassian_account_links_user_id_users_id_fk'
		  AND conrelid = 'atlassian_account_links'::regclass
	) THEN
		ALTER TABLE "atlassian_account_links"
			ADD CONSTRAINT "atlassian_account_links_user_id_users_id_fk"
			FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "atlassian_account_links_by_user" ON "atlassian_account_links" USING btree ("user_id");
