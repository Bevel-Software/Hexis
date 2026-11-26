import type { AcquireLockResult, AuthUser, IVersionControlService } from '@bevel-software/platform-shared';

/**
 * The locks one archive extraction takes, one per entry. Both unzips use this
 * one mechanism, the app's route and the agent's tool, so they follow one
 * rule:
 *
 * - An entry is locked BEFORE its bytes land (`take`). An entry that cannot
 *   be locked (the write gate refuses, someone else holds it) is skipped,
 *   never written over and then refused.
 * - A lock is held from its entry's write to the end of the extraction, and a
 *   long archive can outlast its lease. A lapsed lock may be someone else's
 *   by then, the person's own editor's included, under the same user id,
 *   which a heartbeat or a release cannot tell apart. So before a lock is
 *   used again or released, its lease is renewed and checked to be the
 *   acquisition this extraction took. One that lapsed with nobody taking it
 *   is taken again when its file is to be committed; one held by anyone else
 *   is left alone.
 * - At the end (`releaseAll`), whether the extraction finished or failed
 *   part-way, a file whose bytes are on disk (`wrote`) is committed by its
 *   release. Every other lock (a directory entry, which is created, not
 *   written; the entry a failure stopped) is handed back untouched
 *   (`releaseLockUntouched`, never the discard), so bytes on disk stay.
 */
export interface ArchiveEntryLocks {
  /** Whether this extraction holds a lock it took on `file`. */
  has(file: string): boolean;
  /**
   * Lock `file` before its bytes land. An archive may carry the same path
   * twice: the later entry is written under the lock already taken, once that
   * lock is checked to be still this extraction's, and the earlier write no
   * longer counts as written until this one completes. Throws `refused` (or
   * the acquire's own refusal) when the lock cannot be had.
   */
  take(file: string): Promise<void>;
  /** The extraction reports `file`'s bytes are on disk in full. */
  wrote(file: string): void;
  /**
   * Release every lock taken, committing each written file. Answers the
   * written files that may not be committed: `error` is the release's own
   * failure, absent when the lock was no longer this extraction's.
   */
  releaseAll(): Promise<{ path: string; error?: unknown }[]>;
}

export function archiveEntryLocks(opts: {
  vcs: Pick<IVersionControlService, 'acquireLock' | 'heartbeatLock' | 'releaseLock' | 'releaseLockUntouched' | 'hasQueuedCommit'>;
  workspaceId: string;
  branch: string;
  user: AuthUser;
  /** The refusal for an entry somebody else holds. */
  refused: (file: string, holderName?: string) => Error;
  /** How a lock is asked for; defaults to `vcs.acquireLock`. */
  acquire?: (file: string) => Promise<AcquireLockResult>;
}): ArchiveEntryLocks {
  const { vcs, workspaceId, branch, user, refused } = opts;
  const acquire = opts.acquire ?? ((file: string) => vcs.acquireLock(workspaceId, branch, file, user));
  // When this extraction took each lock: what tells its acquisition apart.
  const acquisitions = new Map<string, string>();
  const written = new Set<string>();

  type Hold = { held: true } | { held: false; holderName?: string };
  const holdOwn = async (file: string, retake: boolean): Promise<Hold> => {
    const renewed = await vcs.heartbeatLock(workspaceId, branch, file, user).catch(() => null);
    if (renewed) {
      return renewed.acquiredAt === acquisitions.get(file) ? { held: true } : { held: false, holderName: renewed.holderName };
    }
    if (!retake) return { held: false };
    const again = await acquire(file);
    if (!again.acquired) return { held: false, holderName: again.lock.holderName };
    acquisitions.set(file, again.lock.acquiredAt);
    return { held: true };
  };

  return {
    has: (file) => acquisitions.has(file),
    async take(file) {
      if (acquisitions.has(file)) {
        const hold = await holdOwn(file, true);
        if (!hold.held) throw refused(file, hold.holderName);
        written.delete(file);
        return;
      }
      const acquired = await acquire(file);
      if (!acquired.acquired) throw refused(file, acquired.lock.holderName);
      acquisitions.set(file, acquired.lock.acquiredAt);
    },
    wrote: (file) => {
      written.add(file);
    },
    async releaseAll() {
      const notCommitted: { path: string; error?: unknown }[] = [];
      for (const file of acquisitions.keys()) {
        const commit = written.has(file);
        const hold = await holdOwn(file, commit).catch((): Hold => ({ held: false }));
        if (!hold.held) {
          // Not this extraction's lock any more: neither committed nor handed back.
          if (commit) notCommitted.push({ path: file });
          continue;
        }
        if (!commit) {
          await vcs.releaseLockUntouched(workspaceId, branch, file, user).catch(() => undefined);
          continue;
        }
        try {
          await vcs.releaseLock(workspaceId, branch, file, user);
        } catch (error) {
          // Hand the lock back with the bytes kept, so a later save can commit them.
          await vcs.releaseLockUntouched(workspaceId, branch, file, user).catch(() => undefined);
          // A release can fail AFTER it queued the commit (the lock row's drop
          // is the step after the enqueue), so ask the queue. It can also have
          // drained that commit already, so "nothing queued" is a maybe.
          const queued = await vcs.hasQueuedCommit(workspaceId, branch, file).catch(() => false);
          if (!queued) notCommitted.push({ path: file, error });
        }
      }
      acquisitions.clear();
      return notCommitted;
    },
  };
}
