/**
 * One in-process notification fired AFTER a set of file changes is committed +
 * pushed (post-lock-release), so backend services can react to KB writes without
 * the per-file TTL wait. Distinct from the SSE `VersionControlEventBus`, which fans
 * scoped events to browser sessions; this is an unscoped, server-side domain hook.
 *
 * BATCHED by design: a single-file save emits `paths: [p]`, a batch write
 * (`LockingFilesystem.writeFiles`, e.g. a bulk node upload) emits ONE event with
 * every path it committed. Subscribers that do expensive per-event work (the
 * id-repair rebuilds the id index) handle a whole batch off one rebuild instead
 * of N back-to-back ones.
 *
 * Only the version-control service emits here: for a single-file write from
 * `runPendingCommit`, and for a batch through `announceCommitted`, which the
 * lock-aware filesystem calls once its locks are released — as does every
 * other committer that lands a change outside it (the admin commit driver,
 * the plugin rename, the access- and join-request splices, a proposal from an
 * embedded page). The notifier is never handed to a filesystem or a caller —
 * a construction site that could leave it out is one whose batches would
 * announce nothing.
 *
 * Every listener is invoked inside try/catch — a throwing subscriber must never
 * fail the commit that triggered it (mirrors the SSE bus's per-subscriber
 * isolation). Firing is fire-and-forget; a listener that needs to write files
 * (id-repair) does so on its own, after the locks have already been released.
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

  /** Fan a change out to every listener; isolate + log each so one can't break the commit. */
  emit(change: FilesChange): void {
    if (change.paths.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        log.error('listener threw:', { err });
      }
    }
  }
}
