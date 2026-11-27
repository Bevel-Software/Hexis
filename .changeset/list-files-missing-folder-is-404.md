---
'@bevel-software/platform-core-backend': patch
---

`list_files` on a folder that is not there, on a file, or on a folder under a file now answers 404 with `kind: not_found`, the requested path (sanitized) and "Check the path with list_files.", as the other file tools do, instead of a 500 carrying the filesystem's own wording. A listing failure that is not absence (a permission or I/O error) is still a 500.
