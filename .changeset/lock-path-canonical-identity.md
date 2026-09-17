---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
---

File locks now coordinate on one canonical file identity, whatever spelling the client sends. `x/a.md`, `./x/a.md` and `x//a.md` are the same lock: a second acquire under any of them is refused exactly as a repeated spelling would be, and release, heartbeat, checkpoint and the lock-status read all find a lock taken under any other spelling. Previously each spelling took a row of its own, so two editors could hold "the" lock on one file at the same time and a release could find nothing to release.

The canonicalisation happens in the lock service, where the row is, so a caller that never goes through the lock routes coordinates on the same identity. A path that escapes the workspace, or that would only become relative by being laundered, is refused by the lock routes with the status the file verbs already answer for that input: 400 for an unusable path, 403 for one that resolves outside the workspace.

A lock row written under a raw spelling before this upgrade is not migrated or dual-matched; it expires on its own heartbeat TTL, so for one deploy an in-flight edit's lock may linger up to a minute.
