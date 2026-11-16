---
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-shared": patch
---

The access check that runs before a protected branch is pushed now reads file names as they really are. A file whose name has a non-ASCII character (`Prüfung.md`) used to be looked up under git's quoted, octal-escaped spelling, which matched no rule but the root one, so a person who could write the file had the push of their save refused: the save stayed on the server and was not shared. A moved file is now checked at the path it left as well as the path it arrived at.

A file an unpushed commit changed may now land when the user who authored the commit may write it at the branch's published state, or the person pushing may. A push that carries a colleague's earlier commits, left behind by a failed push of theirs, lands when that colleague could write what they changed, whatever the pusher's own access. A commit its author may not write is carried by a push from someone who may write the file themselves, so one such commit no longer blocks the branch for everyone. The pusher's own commits, and a commit whose author is not a user of the deployment, are checked against the pusher alone. A merge is checked against the person who made it, for what it brings in.

When this check refuses a push, the person who saved is told that the platform's access check refused it, with the file and who may write it; the file and its writers are named to the person pushing only when they may read that file. The sync banner says the same to everyone on the branch, with or without a role: its headline no longer blames the git host or points at the server logs, and its detail line says the platform's access check refused the push, naming the file and its writers to each person who may read that file at the branch's published state and leaving them out for everyone else. `GitSyncFailedEvent` gains an optional `accessRefusal` marker for this case.

The server log, the pending-commit queue and the recovery agent's prompt record the same refusal as the person pushing was told it, with the roles that may write the file; the people who may write it are counted there, never named. The queue retries such a push and then asks an operator, without running the recovery agent, which cannot change who may write a file.

A push the repository host itself rejected is still described as before. Draft branch pushes and the check made when a file is saved are unchanged.
