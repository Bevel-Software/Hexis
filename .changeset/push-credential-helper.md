---
"@bevel-software/platform-core-backend": patch
---

Fix workspace clones that could commit but never push.

The KB startup phase clones the default branch into the directory
`WorkspaceService` later adopts, but passed its credential helper as `git -c …
clone` — the per-invocation form, which authenticates that one clone and
writes nothing into the repository it produces. Every later `git push` from
that clone then found no helper, prompted for a username, got no tty, and
died. Saves committed locally and reached the remote never; the connection
test still passed, because it builds its own helper for its own invocation.

Credentials now go in as `clone --config`, which persists them, and are
re-stamped whenever an existing clone is adopted from disk — so clones already
broken by this are repaired at next boot rather than staying permanently
unpushable (nothing re-clones a directory that is already there).

Also sets `init: true` on the app service in every shipped compose file. The
app shells out for every git operation, and orphaned grandchildren reparent to
PID 1, which node does not reap — a deployment whose pushes were failing in a
loop accumulated ~4,500 zombie tasks in two days and hit the container's pid
limit.
