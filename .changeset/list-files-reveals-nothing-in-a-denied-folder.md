---
'@bevel-software/platform-core-backend': patch
---

`list_files` answers a path at or under a folder the caller may not read with the same 403 `read_file` gives, whether the path is that folder, a subfolder, a file or nothing at all. Before, it listed the denied folder's subfolder names and told a folder, a file and an absent path apart. A folder the caller may read still lists as before, its unreadable files left out.
