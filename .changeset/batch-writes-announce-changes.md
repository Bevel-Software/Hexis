---
"@bevel-software/platform-shared": minor
"@bevel-software/platform-core-backend": minor
---

Every commit the git service lands is announced to the file-change notifier — a single-file save, an autosave checkpoint, a batch (`write_files`, `delete_folder`, an applied upload, the admin roster commits, a plugin rename), a merge, a `commit_change` — from one place: the git service reports each commit it lands through `VersionControlHooks.onCommitLanded`, and the composition root hands that to the notifier once. Before, only the single-file save path announced; every batch landed silently (catalogs stayed stale for a TTL, the id index was not repaired, a status set by a batch fired no watcher), and so did an autosave checkpoint, a merge and a `commit_change`.

The announcement is made when the commit lands — pushed, or awaiting its push — and a committer that holds file locks still holds them for the moment it takes to release them. A listener that writes an announced path acquires its lock like any writer; the lock-aware filesystem retries a contended acquire (three attempts, two seconds apart), which covers that window. Paths are workspace-relative, sorted and unique; the notifier shapes them.

The database pool now listens for an idle connection the server closes (a restart, a forced drop, a terminated backend): the event is logged and the next query opens a fresh connection, where before an unlistened `error` event could end the process.

For implementers: `LockingFilesystemContext.fileChanges` no longer exists, so a constructor that passed it fails to compile — drop the field; the git layer announces. `VersionControlService` no longer takes a `FileChangeNotifier`; its optional trailing constructor parameters are now `events`, `hooks`, `changeRequestHooks`. `IVersionControlService` is unchanged. A listener on the notifier (the enterprise id-repair) may now be told of a path whose lock its committer is still releasing; it re-acquires through the lock-aware filesystem's retries, as its rewrite already does.
