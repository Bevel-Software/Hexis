-- The tools a person took out of their agent on the Connect page ("Skipped by
-- you"). A skip used to be a deleted credential plus a flag the page held, so a
-- reload undid it; a row here is the choice itself. Unqualified like every
-- other table, so a knowledge base on its own schema gets its own copy.
CREATE TABLE "skipped_tools" (
	"user_id" uuid NOT NULL,
	"manual" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skipped_tools_user_id_manual_pk" PRIMARY KEY("user_id","manual")
);
--> statement-breakpoint
ALTER TABLE "skipped_tools" ADD CONSTRAINT "skipped_tools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
