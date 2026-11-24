---
'@bevel-software/platform-core-backend': patch
---

The agent `unzip` tool commits and shares every file it extracts, moments later, as the app's own unzip route already did: each extracted file goes through a lock and its release, like `save_file`. Before, the files stayed uncommitted until the agent saved each one, and since a branch's access checks answer from the commit its checkout stands on, an `access.md` or a page's own restriction that came in an archive stopped applying once the ten-second wait for a reported change ran out. A file whose lock another person holds, or whose commit is refused, is listed under the new optional `unsaved` output with the reason, and stays on disk for `save_file`. The `commit_change` and `save_file` descriptions and the agent guide say so.
