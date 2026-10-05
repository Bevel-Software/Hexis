---
'@bevel-software/platform-core-backend': patch
---

A clone that was never finished no longer keeps a deployment from starting.

A clone that is cut short (the process stopped, the disk filled) leaves a git folder with no commit. Every start found that working copy again, could not read a commit from it, and stopped with `fatal: ambiguous argument 'HEAD'`, so one such folder took the whole deployment down until someone removed it by hand. A working copy with no commit is now set aside where every other set-aside working copy goes, with whatever files were in it, and cloned again. Nothing is deleted. A working copy that has a commit is left exactly where it is, as before.

A start that stops because one branch's working copy cannot be prepared now says which branch.
