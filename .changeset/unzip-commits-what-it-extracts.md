---
'@bevel-software/platform-core-backend': patch
---

The agent `unzip` tool commits and shares every file it extracts, moments later, as the app's own unzip route already did. Each entry is written under its lock, and the lock's release commits the file. Before, the files stayed uncommitted until the agent saved each one, and since a branch's access checks answer from the commit its checkout stands on, an `access.md` or a page's own restriction that came in an archive stopped applying once the ten-second wait for a reported change ran out.

An entry another person is editing (their lock) is skipped with their name and never written over their work. An extraction that fails part-way commits the files it finished writing; every other lock goes back untouched, including a path the archive carries twice whose later copy did not finish. A file whose release failed with no commit queued for it keeps its bytes on disk, its lock is handed back, and it is listed under the new optional `unsaved` output (beside the error, when the extraction stopped part-way) as one that may not be committed: `save_file` saves it, and saving a file already committed changes nothing. `unzipFile` takes an optional `onWritten` callback, told each file once its bytes are on disk. The `commit_change` and `save_file` descriptions and the agent guide say so.
