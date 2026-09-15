---
'@bevel-software/platform-core-backend': patch
---

Clones nobody opens are retired from the workspaces volume. Every branch anyone ever opened left a full clone of the knowledge base on disk, and nothing removed it until the branch itself was deleted, so the volume only ever grew — and a full volume becomes git failing its writes, which is the hang the git deadline was added for. Once an hour, the process holding the commit-worker lease looks for clones no one has opened in thirty days and removes the ones that carry nothing unpublished.

"Nothing unpublished" is checked with the clone locked, by the git layer, in one hold: a clean working tree, no commit the remote does not have, and nothing waiting in the commit queue. A clone that fails any of the three stays, and the reason is logged. A clone that passes loses nothing by going — the branch lives on origin, and the next time someone opens it the workspace re-clones as it does for any branch opened for the first time. That is what makes the sweep safe to get wrong: a clone retired too early costs its next opener one clone, never their work. Protected branches are never candidates.

"Opened" means a deliberate use — the UI loading the branch, an agent switching to it — and not the background traffic that touches every clone on the volume: the remote sync, the commit worker and the sweep itself do not count, so a webhook that pulls every clone on each push does not make every clone look in use. Any commit to the clone counts too, whichever path made it.

`WORKSPACE_RETENTION_DAYS` sets the period; `0` keeps every clone, as before. The sweep runs only in the lease holder for the same reason the commit worker does: two processes overlap on every redeploy, and only one may be removing clones from the shared volume.
