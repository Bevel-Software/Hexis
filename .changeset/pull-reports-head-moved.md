---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
---

A sync that finds nothing new no longer clears the server's catalog caches or makes open browser tabs reload their file tree. `IGitService.pull` now reports whether the pull actually moved the working tree, and the "tree changed" announcement only goes out when it did.
