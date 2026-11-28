---
'@bevel-software/platform-core-backend': patch
---

A grant, revoke or deny-here (`POST /workspace/:id/access/grant` and `/access/revoke`) on a file target that does not exist now answers 404 with `kind: not_found`, the requested path (sanitized) and "Check the path with list_files.", instead of a 500 "Internal error.". Nothing is locked or written. A caller the write gate refuses still gets its 403, the same for a missing file as for an existing one. Folder targets with no `access.md` yet are unchanged.
