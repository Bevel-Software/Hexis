---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-shared': patch
---

A held editor lock no longer outlives the write access it was taken under. A save from someone who holds a file's lock is checked against the access rules as they are at the moment of the save, not as they were when Edit took the lock. So when an admin removes their write while they are editing, the save is refused with the same 403 a non-writer gets, nothing is written, and their lock is released. Bytes they saved before the grant was removed are still committed. This covers every save that writes under a lock the caller already holds: the file routes (`PUT`, `DELETE` and move on `/file`, uploads, folders), the access-rule edits, and the embed's Save. The question goes through one new version-control call, `holdsEditLock`. A caller's own coordination hold no longer counts as holding the lock for those saves on the file routes and the access-rule edits; the embed already worked that way.
