---
'@bevel-software/platform-core-frontend': patch
---

Approve in a proposal box under a file (the file page and the skill page) now records an approval on that file only. The request applies only when the merge gate then waits on no other file; until then the box says the approval is recorded and how many other files the request still waits on. Before, the click approved every file of the request the person could approve, files never shown included, and applied it. The change request dialog's Apply is unchanged.
