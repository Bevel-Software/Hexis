---
'@bevel-software/platform-core-backend': patch
---

An admin can now add a page directly in the knowledge folder again. The deployment owner is an Admin for every purpose, not only for writing: they see, download and change exactly what a member of the Admin role does, and are kept out exactly where that role is. And because writing implies reading, an admin who may change everything under the root may also see it, whether or not the root's rules name them — a subfolder that excludes Admin still does. Before this, an owner the roles file did not name could create a folder in the knowledge root but not a page: the write rules let them in and the read rules did not.
