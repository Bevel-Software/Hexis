---
'@bevel-software/platform-shared': patch
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

An empty sidebar now says why it is empty. The file listing (`GET /api/workspace/:id/files`, and the tree `GET /api/workspace` returns) carries `withheld` on its root: how many entries the caller's read rules kept out, as a number and never as names, present only when non-zero. When nothing is visible, the Knowledge explorer and the Skills and Plugins trees show "Nothing here is shared with you yet. Ask an admin to grant you access." if entries were withheld, and otherwise "This knowledge base is empty.", followed by a hint to create something when the caller may write at the root. Neither message appears once a single entry is visible. Hiding the admin-only `.bevelignore` from a non-admin does not count as withholding. Permissions do not change.
