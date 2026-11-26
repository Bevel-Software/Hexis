---
'@bevel-software/platform-core-backend': patch
---

An agent write to the root `groups.yaml` that would declare a group whose canonical (case- and whitespace-insensitive) name the file already declares — `PRODUCT:` beside `Product:` — is refused with a 422 naming both spellings, and nothing is written. Before, the write landed, the resolver kept the first block and skipped the other, so the existing members vanished from the app and the group editor's next save deleted them from the file. The check runs in the agent's write gate, before the lock and again under it, so it covers `write_file`, `write_files`, `edit_file`, `apply_file_upload`, appends, copies, moves and `update_branch` resolutions alike; `unzip` never extracts a root `groups.yaml`, as it already never extracted `roles.yaml`. A duplicate the file already holds is left alone, so it does not block unrelated edits. The app's raw file editor is not covered by this check.
