---
'@bevel-software/platform-core-frontend': patch
---

The sidebar asks before it deletes or moves. Delete opens "Delete <name>?" — for a folder, "Delete <folder> and its N files?", or "Delete <folder> and everything in it?" with the visible count when the caller's read rules kept entries out of that folder, since the delete takes files the tree could not count — and Cancel leaves it alone. Dropping a file or folder into another folder opens "Move <name> to <destination>? Access to it will follow <destination>'s rules from now on.", plus a warning when one applies: the destination is a folder you can't write (the move will be refused), the file is platform-managed (`AGENTS.md`, `roles.yaml`, `access.md`), or the move crosses from one root folder into another. Nothing is sent until Confirm; Enter confirms, Escape cancels, and focus returns to the row. A refused move now says so instead of failing silently.
