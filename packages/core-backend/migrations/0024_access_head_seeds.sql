-- Where the access service's head maps start from after a restart: the last
-- commit a map was made of and the files of it that declare access of their
-- own, by path and object id. Paths and ids only, no rule and no person; one
-- row per deployment, read only by the release that wrote it.
CREATE TABLE "access_head_seeds" (
	"key" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"commit" text NOT NULL,
	"declaring" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
