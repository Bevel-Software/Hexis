---
'@bevel-software/platform-core-backend': patch
---

A save commits the one file it saved. `GitService.commitFile` now commits with that file's path, as a scoped `commitChanges` does, so an entry something else left staged in the shared workspace no longer lands in the commit under the saver's name, and the commit's `contentEdit` describes the only file it holds. The other entry stays staged.
