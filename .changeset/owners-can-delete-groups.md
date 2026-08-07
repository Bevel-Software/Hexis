---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Owners can delete their groups. Creating a group makes you the one who runs
it; deleting it is the other end of that same promise, and until now the
promise had no other end — no endpoint stood behind Delete, so the UI
(correctly) refused to show a menu item that could not do its job.

The endpoint is `DELETE /api/groups/:name`, gated on the `owner` verdict on
the group FOLDER — owner-lists only, no admin rescue. A manager who merely
writes the access.md, and an admin rescued into managing it, do not get the
verb. Fail-closed like every other group surface: an unknown group and a
group the caller does not own answer identically, so probing the endpoint
confirms nothing about what exists.

The mechanism lives where creation's does, in `GroupProvisionService` — the
one privileged door for a `Groups/<name>/` folder's existence now swings both
ways. A delete parks the folder (a dot-prefixed sibling the scanners ignore),
commits the removal synchronously in ONE folder-scoped commit
(`systemAuthorized`, for creation's reasons in reverse), and only a landed
commit lets the parked bytes go: a refused push renames the folder back, so a
failed delete is a no-op rather than a group that exists at origin but not on
disk. Personal folders are not deletable through this door at all.

The UI shows the verb to exactly the people the endpoint will let through:
`GroupSummary` now carries `isOwner` (a new batched `canOwnerBatch` resolves
it alongside the read/write probes), and both surfaces the user asked for
gate on it — `Delete group` in the sidebar's right-click menu and in the
group page's `⋯` menu, destructive and last, below its own rule. Both open
the same confirmation dialog, which says what is actually at stake (the
group's skill and tool counts, deletion for everyone, git history as the only
undo) before calling the endpoint.
