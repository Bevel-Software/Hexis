---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

A tab left open on a branch that was deleted on the git host used to fail with "Something went wrong" and a Retry that could never succeed. It now says "This branch no longer exists" and offers a button to the default branch, whether the branch vanished while the tab was open or was never there when the tab loaded. Behind it, the platform tells git's "no such branch" apart from an unreachable host or a refused credential, and answers 410 with the branch named.
