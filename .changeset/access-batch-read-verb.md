---
'@bevel-software/platform-core-backend': patch
---

The batch access lookup (`POST /api/workspace/:id/access/batch`) answers `verb: read` too: the verdict the single lookup gives as `canRead`, for up to 500 paths in one request. New page asks it on a draft branch, where a page may go wherever its author may read, instead of one request per Knowledge folder.
