---
'@bevel-software/platform-core-backend': patch
---

A refused access change (for example a `stale-ancestor` 409 or an `admin-root-write` 403) no longer discards an earlier change to the same `access.md` whose commit is still queued. Before, the refusal reset the file to its last commit, so a grant that had just answered 200 was lost. Now, when a failed access change leaves the file's bytes exactly as it found them, the lock is released without touching the file or the commit queue. A failure that changed the bytes, or left them unreadable, still resets the file, so partial bytes are never committed.
