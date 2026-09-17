---
'@bevel-software/platform-core-backend': patch
---

The repository's internal `.git` folder can no longer be reached through any workspace tool (stat, read, grep, list, write, write_files, edit, delete, mkdir, move, copy, unzip) or workspace HTTP route (read, raw read, download, folder download, write, upload, delete, move, mkdir, unzip). A path is refused when any segment is `.git` in any letter case, after `..`, percent-encoding and symbolic links are resolved. That includes a link in the repository that points into the folder. Every refusal is the same 403, "That path is inside the repository's internal git data and is not available.", whether or not the path exists. Archive entries aimed at the folder are skipped. Listings still hide the folder, and now also hide links into it.
