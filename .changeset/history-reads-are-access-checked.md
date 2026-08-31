---
'@bevel-software/platform-core-backend': patch
---

The file-history endpoints (`workflow/changes`, `show-file`, `file-at-change`, `compare-file`) now enforce the same per-file `read:` verb as the content routes. A file's history is its content with a time axis; these routes previously required only an authenticated user, so a read-denied file's commit list, diffs, and full content at any commit were reachable by path.
