---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-shared": patch
---

The access check that runs before a protected branch is pushed now reads file names as they really are. A file whose name has a non-ASCII character (`Prüfung.md`) used to be looked up under git's quoted, octal-escaped spelling, which matched no rule but the root one, so a person who could write the file had their save refused. Each unpushed commit is now checked against the user who authored it, at the branch's published state. A push that carries a colleague's earlier commits, left behind by a failed push of theirs, lands when that colleague could write what they changed, whatever the pusher's own access. The pusher's own commits, and a commit whose author is not a user of the deployment, are checked against the pusher. A merge is checked against the person who made it, for what it brings in.

When this check refuses a push, the person who saved and the pending-commit queue are told that the platform's access check refused it, with the file and who may write it; the file and its writers are named to the person pushing only when they may read that file. The sync banner says the same to everyone on the branch, with or without a role: its headline says Hexis's access check refused the push instead of blaming the git host, and its detail line names the file and its writers to each person who may read that file at the branch's published state, and leaves them out for everyone else. `GitSyncFailedEvent` gains an optional `accessRefusal` marker for this case. A push the repository host itself rejected is still described as before. Draft branch pushes and the check made when a file is saved are unchanged.
