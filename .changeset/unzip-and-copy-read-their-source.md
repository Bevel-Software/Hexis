---
'@bevel-software/platform-core-backend': patch
---

Extracting an archive and copying a file now need read access to what they read. The agent `unzip` tool and the app's `POST /workspace/:id/unzip` refuse an archive the caller may not read with `read_file`'s own refusal (403, "You don't have permission to read …"), before a byte of it is read: nothing is written and no entry of it is named. Before, neither asked the read rule of the archive, so a person who could not read a zip could extract it into a folder they could read, and read what it held. `copy_file` refuses a source the caller may not read the same way, its dry run too, once the write verdict on the destination has let it go on; it asks the deployment's read hook first, as `read_file` and `move_file` do. A file you staged in the workspace's tmp folder (`__tmp__/…`) is yours and copies as before.

`ArchiveEntryJudge` asks one more question, `archive(wsPath)`: may the caller read the archive. `WorkspaceService.unzipFile` asks it before it reads the archive, and what it throws is the extraction's answer. `archiveEntryJudge` answers it with the read rule, as `read_file` does.
