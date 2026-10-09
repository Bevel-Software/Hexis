---
'@bevel-software/platform-core-backend': patch
---

A file held for editing in the app now stops its branch from being deleted, on every branch.

The app takes its file locks under the workspace id the route decoded (`alice/draft`), while the deletion checks asked under the encoded one (`alice%2Fdraft`), so on any `<name>/…` branch a held file went unseen: `delete_branch` (with or without `discardUnmerged`), the background close of empty change requests and the leftover-branch cleanup could all remove the branch with a file on it held. The lock store now keys every lock on one canonical workspace id, the same one queued saves use, so both spellings find it. Locks taken before the upgrade expire on their own within a minute.
