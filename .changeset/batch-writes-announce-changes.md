---
"@bevel-software/platform-shared": patch
"@bevel-software/platform-core-backend": patch
---

A batch write (`write_files`, `delete_folder`, an applied upload) announces its files to the file-change notifier like a single write does. The announcement is the version-control service's (`announceCommitted` on `IVersionControlService`), made by the lock-aware filesystem once its locks are released, so no construction site can leave the notifier out; the lock context's `fileChanges` field is gone. Before, the agent tools' filesystem was built without the notifier and every batch landed silently: catalogs stayed stale for a TTL, the id index was not repaired, and a status set by a batch fired no watcher.
