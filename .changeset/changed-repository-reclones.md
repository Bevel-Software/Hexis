---
'@bevel-software/platform-core-backend': patch
---

A deployment whose knowledge-base repository address changed recovers on its own, and loses nothing doing so. A working copy fetches through the address it was cloned from, so after a change every surviving clone kept asking the old one and a replaced repository stopped the boot with "repository not found".

At startup, once the configured repository has answered, each working copy cloned from a different address is looked at:

- If the configured repository holds its history, it is the same repository at a new address (moved, renamed, mirrored). The working copy is pointed at the new address and kept, unpushed commits included.
- Otherwise it is a clone of another repository. It is moved to `replaced-working-copies/<time>/` under the backups root, the log says where, and a fresh clone of the configured repository takes its place. Nothing is deleted: when the old repository is gone these clones are the last copy of its content, and work that was never pushed is in that folder.

Working copies of the configured repository are left untouched, and a different spelling of the same address (a trailing slash, a `.git` suffix, host letter case) is not a different repository.
