---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-shared': minor
---

A save that cannot change the file tree no longer makes every open tab fetch the whole tree. Until now every write was announced with `file-changed` and `fs-tree-changed`, and the web app asked for the tree on each, one request per event per tab; on a branch where agents save every few seconds the server spent much of its time building trees for answers nobody read.

Both events can now carry `listingUnchanged: true`. The sender sets it when an existing file's content changed, nothing was added, removed or renamed, and the file decides nobody's access: not an `access.md`, the roles or groups files, a plugin manifest or a `.bevelignore`, and the file's own leading `---` block is the same as before. A commit of one file reports this as `CommitAttribution.contentEdit`, told from the status git already answers; for a file that can carry access entries it costs one read of the version it replaces. The web app keeps its tree on a marked event, and a burst of unmarked events shares two tree requests, the one under way and one after it. An event without the mark means what it always meant, so a batch write, an upload, a move, a delete and a sync are announced as before. The server's own listeners of `fs-tree-changed` are unaffected: the event is still emitted for every write.

The workspace service lists part of a tree. `listFilesUnder(workspaceId, path, { depth, readFilter })` answers one folder's subtree exactly as the whole tree holds it, read filter and `.bevelignore` rules included, by walking that folder alone; `depth` cuts it, and a folder at the cut has no `children`. `listFilesToDepth(workspaceId, depth, readFilter)` cuts the whole tree the same way. `IWorkspaceService` gains `listFilesUnder`, so an implementation of that interface outside this repository must add it. The list of access rules inside a folder now asks for that folder instead of the whole tree.
