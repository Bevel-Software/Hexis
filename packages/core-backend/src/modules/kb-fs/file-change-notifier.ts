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
 * layer's reservation. A listener that only reads (the catalogs) is
 * unaffected by locks. A listener that WRITES an announced path acquires its
 * lock like any writer, and two cases differ: a batch's committer (the
 * lock-aware filesystem, the admin commit driver) releases its locks right
 * after the commit, and the lock-aware filesystem's acquire retries cover that
 * moment; an editor's autosave checkpoint is announced while the editor's own
 * lock is held, for as long as the person keeps editing, so a write to that
 * path cannot be made then. The editor's release commit announces the path
 * again when it carries new bytes; a release that finds nothing new does not,
 * and such a write waits for the file's next change — as it did before this
 * release, when a checkpoint was not announced at all.
 *
 * Every listener is invoked inside try/catch — a throwing subscriber must never
 * fail the commit that triggered it (mirrors the SSE bus's per-subscriber
 * isolation). Firing is fire-and-forget.
 */
import type { FilesChange } from '@bevel-software/platform-shared';
import { callFireAndForget, type FireAndForgetListener } from '../../shared/fire-and-forget.js';
import { logger } from '../../shared/logging.js';

const log = logger('file-change');

export type { FilesChange };

/** Fire-and-forget: a listener may answer a promise, which nobody awaits; a rejection is logged like a throw. */
export type FilesChangedListener = FireAndForgetListener<FilesChange>;

export class FileChangeNotifier {
  private readonly listeners = new Set<FilesChangedListener>();

  /** Register a listener. Returns an unsubscribe fn. */
  onFilesChanged(listener: FilesChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fan a change out to every listener — paths sorted and unique, nothing for an empty set; each isolated (a throw or a rejection is logged) so one can't break the commit. */
  emit(change: FilesChange): void {
    const paths = [...new Set(change.paths)].sort();
    if (paths.length === 0) return;
    const shaped: FilesChange = { ...change, paths };
    for (const listener of this.listeners) {
      callFireAndForget(listener, shaped, log, 'a file-change listener failed:');
    }
  }
}
