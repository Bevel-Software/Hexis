---
'@bevel-software/platform-core-backend': patch
---

A deployment pointed at a different knowledge-base repository recovers on its own. Working copies cloned from the previous repository are deleted at startup and cloned fresh from the configured one, so a replaced repository no longer stops the boot with "repository not found". Working copies of the configured repository are left untouched, and a different spelling of the same address (a trailing slash, a `.git` suffix, host letter case) is not a different repository. Work committed on the server and never pushed to the previous repository is lost with its working copy.
