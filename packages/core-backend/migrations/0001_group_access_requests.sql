-- Group access requests. Hand-edited after `drizzle-kit generate` for the same
-- idempotency the squashed 0000 carries: every statement is IF NOT EXISTS, so a
-- re-run (or a database that already has the table) no-ops instead of failing.
CREATE TABLE IF NOT EXISTS "group_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_name" text NOT NULL,
	"requester_email" text NOT NULL,
	"requester_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp,
	"resolved_by_email" text,
	CONSTRAINT "group_access_requests_status" CHECK ("group_access_requests"."status" IN ('pending', 'fulfilled', 'dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_access_requests_pending_unq" ON "group_access_requests" USING btree ("group_name","requester_email") WHERE "group_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_access_requests_by_group" ON "group_access_requests" USING btree ("group_name","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_access_requests_by_requester" ON "group_access_requests" USING btree ("requester_email","status");
