/**
 * One in-process notification per commit the git service lands — a single-file
 * save, an autosave checkpoint, a batch (`LockingFilesystem.writeFiles`, a
 * bulk upload, the admin roster commits, a plugin rename), a merge, a
 * `commit_change` — fired when the commit lands: pushed, or awaiting its push
 * (the later push makes no new commit and is not announced again). Backend
 * services react to KB writes here without the per-file TTL wait. Distinct
 * from the SSE `VersionControlEventBus`, which fans scoped events to browser
 * sessions; this is an unscoped, server-side domain hook.
 *
 * ONE SOURCE. The git service reports every commit it lands through
 * `VersionControlHooks.onCommitLanded`, and the composition root hands that to
 * this notifier once; nothing else emits here, and a test pins both. A commit
 * made some other way (the startup runner's seed of a fresh knowledge base,
 * before any catalog exists) is the one commit this does not see.
 *
 * BATCHED by design: a single-file save emits `paths: [p]`, a batch emits ONE
 * event with every path it committed, a merge every path it brought in — so a
 * subscriber that does expensive per-event work (the id-repair rebuilds the id
 * index) handles a whole batch off one rebuild instead of N back-to-back ones.
 * Paths are workspace-relative, sorted and unique: `emit` shapes them.
 *
 * TIMING. The announcement is made when the commit lands, inside the git
 * layer's reservation; a committer that holds file locks (the lock-aware
 * filesystem's batches, an editor's autosave checkpoint) still holds them for
 * the moment it takes to release them. A listener that writes an announced
 * path acquires its lock like any writer, and the lock-aware filesystem's
 * acquire retries cover that window; a listener that only reads is unaffected.
 *
 * Every listener is invoked inside try/catch — a throwing subscriber must never
 * fail the commit that triggered it (mirrors the SSE bus's per-subscriber
 * isolation). Firing is fire-and-forget.
 */
import type { FilesChange } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';

const log = logger('file-change');

export type { FilesChange };

export type FilesChangedListener = (change: FilesChange) => void;

export class FileChangeNotifier {
  private readonly listeners = new Set<FilesChangedListener>();

  /** Register a listener. Returns an unsubscribe fn. */
  onFilesChanged(listener: FilesChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fan a change out to every listener — paths sorted and unique, nothing for an empty set; isolate + log each so one can't break the commit. */
  emit(change: FilesChange): void {
    const paths = [...new Set(change.paths)].sort();
    if (paths.length === 0) return;
    const shaped: FilesChange = { ...change, paths };
    for (const listener of this.listeners) {
      try {
        listener(shaped);
      } catch (err) {
        log.error('listener threw:', { err });
      }
    }
  }
}
