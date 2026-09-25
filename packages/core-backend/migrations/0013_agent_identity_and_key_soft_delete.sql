-- An agent connection is the AGENT per person, not the OAuth client
-- registration: Claude registers a fresh client on every re-authorisation,
-- so keying by registration gave one person a row per sign-in. The key is
-- now the folded client name (the client id for a name-less registration).
-- Rows that already exist are backfilled with the same fold the provider
-- applies, and the live duplicates each person has under one key are MERGED
-- into the earliest of them: their tokens and events move to it, so nothing
-- an agent did is lost, and the rest are removed.
--
-- Written by hand around the generated DDL, since the generated version
-- would add a NOT NULL column to a populated table and build a unique index
-- over rows that still collide. Guarded, like 0011: a database built from a
-- head where this already ran no-ops instead of failing.
DROP INDEX IF EXISTS "agent_connections_live_unq";--> statement-breakpoint
ALTER TABLE "agent_connections" ADD COLUMN IF NOT EXISTS "agent_key" text;--> statement-breakpoint
UPDATE "agent_connections" SET "agent_key" = COALESCE(NULLIF(lower(btrim("client_name")), ''), "client_id") WHERE "agent_key" IS NULL;--> statement-breakpoint
CREATE TEMP TABLE "agent_connection_dupes" AS
SELECT "id", first_value("id") OVER (PARTITION BY "user_id", "agent_key" ORDER BY "connected_at", "id") AS "keeper"
FROM "agent_connections"
WHERE "revoked_at" IS NULL;--> statement-breakpoint
DELETE FROM "agent_connection_dupes" WHERE "id" = "keeper";--> statement-breakpoint
UPDATE "oauth_tokens" t SET "connection_id" = d."keeper" FROM "agent_connection_dupes" d WHERE t."connection_id" = d."id";--> statement-breakpoint
UPDATE "agent_events" e SET "connection_id" = d."keeper" FROM "agent_connection_dupes" d WHERE e."connection_id" = d."id";--> statement-breakpoint
UPDATE "agent_connections" k SET "last_used_at" = GREATEST(k."last_used_at", (SELECT MAX(a."last_used_at") FROM "agent_connections" a JOIN "agent_connection_dupes" d ON d."id" = a."id" WHERE d."keeper" = k."id")) WHERE k."id" IN (SELECT DISTINCT "keeper" FROM "agent_connection_dupes");--> statement-breakpoint
DELETE FROM "agent_connections" a USING "agent_connection_dupes" d WHERE a."id" = d."id";--> statement-breakpoint
DROP TABLE "agent_connection_dupes";--> statement-breakpoint
ALTER TABLE "agent_connections" ALTER COLUMN "agent_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_connections_live_unq" ON "agent_connections" USING btree ("user_id","agent_key") WHERE "agent_connections"."revoked_at" is null;
