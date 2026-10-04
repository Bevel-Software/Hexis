---
'@bevel-software/platform-core-backend': patch
---

A working copy of a replaced repository is set aside once, however many callers open its branch together.

Two callers opening a branch at the same moment both read the old working copy's address. The first set it aside and began cloning the new repository in its place. The second came back with its answer after that move had ended, when nothing said a move was in flight any more, and set aside what was at the path by then: the fresh clone the first caller was in the middle of making. The branch then failed to open with git's own error about a file that was not there, and a second folder appeared under `replaced-working-copies` holding a half-made clone of the right repository.

The move now says that the copy was taken away, the way the startup phase says it, and a caller whose look at the old copy predates that does not move anything: it waits for the clone like any other caller.
