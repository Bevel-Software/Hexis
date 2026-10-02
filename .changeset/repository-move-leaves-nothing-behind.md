---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A working copy that is set aside takes its work with it, wherever it is set aside from. Opening a branch whose working copy belongs to another repository now does what the startup phase does around the same move: the commit worker is held still, the copy's queued commits are held for an admin instead of being committed into the fresh clone, and the locks on its branch are dropped. The startup phase drops those locks too. If any of that cannot be done, the copy stays where it is.

Also: two moves at once wait for the same commit in flight, shutdown waits for a move even on a process that never held the commit-worker lease, a set-aside never lands in or removes a folder that already holds an earlier one, and a working copy taken away while it was being opened is no longer registered as the branch's.

The setup screen's message after a move no longer promises fresh working copies, since a repository that only moved keeps the ones it had.

`WorkspaceService` takes an optional seventh constructor argument, `aroundSetAside`.
