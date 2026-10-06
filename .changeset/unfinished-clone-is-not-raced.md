---
'@bevel-software/platform-core-backend': patch
---

Setting an unfinished clone aside at start no longer gets in the way of anything else working on the same working copy.

0.25.1 moved a working copy that has a git folder and no commit out of the way and cloned it again. A clone that is still running looks exactly like that on disk, and on a running server, or for the few seconds two processes share the volume on a redeploy, something else can be working on the same path. Four things follow from that and are fixed here:

- An unfinished clone is left alone until nothing has been written to it for a minute. One that finishes meanwhile is used as it is.
- A working copy that is taken away by something else just before the move no longer stops the start; the start clones and carries on, and reports only a move it made itself.
- After a move, the start reads the path again before cloning. A clone that somebody else began there in the meantime is kept, never removed.
- The work queued against a working copy that was set aside is released a second time if the first attempt fails, before the replacement clone is used.

A start that meets a clone cut short by a restart now waits up to a minute before setting it aside.
