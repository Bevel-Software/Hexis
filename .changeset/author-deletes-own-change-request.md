---
'@bevel-software/platform-shared': minor
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

The author of a change request can now delete it, the same verb admins already had and with the same effect: the request closes and stays in history as closed, and its branch is removed from the shared repository. Withdraw, which closes the request but leaves the branch for the next proposal to reuse, is unchanged and stays where it is (the file-tree right-click and the file-page change boxes).

`DELETE /api/workflow/change-requests/:number` now admits the request's stored author as well as admins, and refuses everyone else — the changed files' owners included — with 403 "Only the request's author or an admin can delete it." (previously "Only an admin can delete a change request."). Owners keep Decline, which leaves the author's branch to rework. Authorship is read from the stored author hash, never from anything the caller sends, and a request a person's agent opened belongs to that person. No agent tool deletes change requests. Every other outcome is as before: an applied request is refused with 422, an unreachable origin with 409 and nothing changed, and a branch another open request still uses is kept while the request closes.

In the change-request dialog, "Delete request" is shown to the author and to admins and keeps its two-step confirm, now also on a request stuck on a conflict — the one its author most wants to throw away and propose again. The armed button names the branch it will remove ("Really delete request and branch juan/fix-copy?") unless the platform made it (`suggestions/...`), which keeps the generic wording; authors and admins read the same sentence. The "nothing left to change" message now ends "You can delete it below." for the author and "<first name> can delete it." for everyone else.

`PullRequestDetail` gains two required fields, `viewerCanDelete` and `viewerIsAuthor`: anything that builds one by hand must add them.
