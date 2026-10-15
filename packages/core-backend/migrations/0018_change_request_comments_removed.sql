-- Change-request comments are removed: no screen ever rendered one, so a
-- comment posted through the API or an agent tool was invisible to everyone.
-- The routes, the service methods and the agent tools went with this release;
-- the rows go here. A request's title and description are edited in place
-- instead (`PATCH /api/workflow/change-requests/:number`).
DROP TABLE IF EXISTS "pr_comments" CASCADE;
