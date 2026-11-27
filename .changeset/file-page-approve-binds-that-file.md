---
'@bevel-software/platform-core-frontend': patch
---

Approve in a proposal box under a file (the file page and the skill page) now records an approval on that file only, and only when the merge gate binds that file. The request applies only when the gate then waits on no other file. Until then, that file's box says how many other files still needed approval at that press, and its button reads Apply: pressing it checks again and applies once nothing waits. On the skill page, Approve is offered only to a viewer who may write the file on screen. Before, the click approved every file of the request the person could approve, files never shown included, and applied it. The change request dialog's Apply is unchanged.
