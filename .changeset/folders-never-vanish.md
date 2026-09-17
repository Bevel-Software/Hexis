---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-shared': minor
---

A folder exists until someone deletes it. Deleting the last file in a folder, or moving it out — from the file explorer or with the agent's `delete_file` / `move_file` — leaves the folder in place: an empty placeholder (`.gitkeep`) is written and committed in the same request, so the folder is still there after a fresh clone and in a new session. Only an explicit folder delete removes a folder, and it removes the placeholder with it; the folder that held the deleted one stays.

The placeholder is never shown as content: `list_files`, the file tree, `grep` and the change-request file list leave it out, and `file_stat` on it answers 404 like any path with nothing there. `file_stat` on a missing path now answers 404 instead of 500. Creating a folder in the UI, with `mkdir`, or by writing a file into a new folder all end in the same state: a folder that lists as a folder. `@bevel-software/platform-shared` exports `FOLDER_PLACEHOLDER`, `isFolderPlaceholder` and `folderPlaceholderPath`.
