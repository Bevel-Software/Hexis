---
'@bevel-software/platform-core-backend': patch
---

A folder download no longer packs files the caller may not read or download.

`download` on a folder let anyone with it save the whole folder as a zip, and the zip held every file under the folder: no file was judged against its own rules. So a caller got files whose frontmatter denied them `download`, files whose frontmatter denied them `read`, and whole sub-folders a nested `access.md` closed to them — files the per-file download refused and the file tree never showed.

Every file the zip would pack is now judged the way the per-file download judges it, `read` first and then `download`, in one pass over the folder, and a file that fails either is left out. Nothing in the answer names a left-out file. The response carries `X-Withheld-Files`, the number of files the caller could read but not download; files they could not read are not counted, so the header says nothing the tree does not.

For integrators: `IAccessControl` gains `canDownloadBatch`, and `WorkspaceService.createFolderZip` takes a required filter that decides which of the folder's files go in — there is no default that packs everything.
