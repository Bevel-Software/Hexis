---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
'@bevel-software/platform-shared': minor
---

A change request's title and description can be edited after it is opened — by its author, or by anyone who may merge it — from an Edit control in the request's dialog, through `PATCH /api/workflow/change-requests/:number`, and by an agent with the new `update_change_request` tool (which can also append a paragraph). The comment system is removed: no screen ever rendered a comment, so one posted through the API or an agent tool was invisible to everyone; the routes, the `post_change_request_comment` and `list_change_request_comments` tools and the `pr_comments` table go.

A request's body is now nothing but its description. Hexis no longer appends an "Affected owners" block when a request is opened (it was a snapshot nothing read back — who must approve each file is resolved live from the access rules), and an access request's level and note are columns of the request rather than hidden markers in its prose. The first start on this release moves what the stored bodies held onto those columns and leaves the description; the agent's `get_change_request` and the dialog's quote show the body as stored. Adds `access_request_level` and `access_request_note` to `change_requests` (migration 0020).
