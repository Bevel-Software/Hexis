---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

A folder exists until someone deletes it. Deleting the last file in a folder, or moving it out — from the file explorer or with the agent's `delete_file` / `move_file` — leaves the folder in place: an empty placeholder (`.gitkeep`) is written and committed in the same request, so the folder is still there after a fresh clone and in a new session. Only an explicit folder delete removes a folder, and it removes the placeholder with it; the folder that held the deleted one stays. A folder delete and a file delete racing inside it no longer bring the deleted folder back, and a delete whose folder cannot be kept answers an error that says the file itself is gone, instead of success.

The placeholder is never shown as content: `list_files`, the file tree, `grep`, the change-request file list, the change-request list's touched paths (and the file counts built on them), a revert's remaining files and the generated "Affected owners" block leave it out (an empty file replaced by the placeholder still shows as removed, and a request that only creates a folder still reaches that folder's owners), and `file_stat` on it answers 404 like any path with nothing there. `file_stat` on a missing path now answers 404 instead of 500. Creating a folder in the UI, with `mkdir`, or by writing a file into a new folder all end in the same state: a folder that lists as a folder. `@bevel-software/platform-shared` exports `FOLDER_PLACEHOLDER`, `isFolderPlaceholder` and `folderPlaceholderPath`.
