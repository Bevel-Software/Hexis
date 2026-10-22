-- A change request's body is its description and nothing else.
--
-- Comments go: no screen ever rendered one, so a comment posted through the
-- API or an agent tool was invisible to everyone. The routes, the service
-- methods and the agent tools went with this release; the rows go here. A
-- request's title and description are edited in place instead
-- (`PATCH /api/workflow/change-requests/:number`, `update_change_request`).
--
-- An access request's level and note become columns of the request. Until
-- now the body carried them in hidden markers (and an `## Affected owners`
-- block nothing read back); the start that applies this moves what the old
-- bodies held onto these columns and leaves the prose, once, in application
-- code (`moveLegacyRequestBodies` in `migrate.ts`: the column is sealed, SQL
-- cannot read it), recorded in `data_migrations` (0021) by the transaction
-- that does it.
ALTER TABLE "pr_comments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "pr_comments" CASCADE;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "access_request_level" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD COLUMN "access_request_note" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_access_request_level_check" CHECK ("change_requests"."access_request_level" IS NULL OR "change_requests"."access_request_level" IN ('write', 'owner'));