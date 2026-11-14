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
 * before any catalog exists) is the one commit this does not see. A commit
 * that ARRIVES by a pull was landed — and announced — by the process that made
 * it; a pull of the default branch also announces the tree change on the SSE
 * bus (`fs-tree-changed`), which the catalogs listen to, and a pull rebases
 * this process's own commits without re-announcing them (their content is
 * unchanged).
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
 * lock-aware filesystem, the admin commit driver) releases its locks once the
 * commit's push has either gone through or been handed off to the recovery
 * worker (the push is then still owed, and the lock no longer guards the
 * path) — the lock-aware filesystem's acquire retries (three, two seconds
 * apart) cover the usual push, and a push that outlasts them leaves the writer
 * to skip; an editor's autosave checkpoint is announced while the editor's
 * own lock is held, for as long as the person keeps editing, so a write to
 * that path cannot be made then. In both cases the path's next announcement —
 * the editor's release commit when it carries new bytes, the next change to
 * the file — is when such a writer catches up; a writer that skips must
 * therefore treat "could not lock" as "not now", as the id-repair already
 * does. Before this release a batch was announced only where its filesystem
 * had been handed the notifier, and a checkpoint not at all.
 *
 * Every listener is invoked isolated (`callFireAndForget`): one that throws, or
 * whose promise rejects, is logged and never fails the commit that triggered
 * it (mirrors the SSE bus's per-subscriber isolation). Firing is
 * fire-and-forget; nothing awaits a listener.
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
