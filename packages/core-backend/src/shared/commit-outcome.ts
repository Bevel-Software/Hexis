import type { Change, FilesChange, IVersionControlService } from '@bevel-software/platform-shared';
import { PushNeedsAgentResolutionError } from './domain-errors.js';

/**
 * Announce a landed batch that was committed under file locks, naming only
 * the paths whose lock was given back — the one rule for every committer that
 * holds locks (the lock-aware filesystem's batches, the admin commit driver).
 * A path whose release failed stays locked until TTL: a reactor told of it
 * now could not take it, so it is left out, and its catalogs refresh when
 * the lock frees. Nothing is announced when no path was released.
 */
export function announceReleased(
  service: Pick<IVersionControlService, 'announceCommitted'>,
  change: FilesChange,
  stillHeld: ReadonlySet<string>,
): void {
  const paths = change.paths.filter((p) => !stillHeld.has(p));
  if (paths.length > 0) service.announceCommitted({ ...change, paths });
}

/**
 * What one call of `commitChanges` came to: the change it answered (null for
 * a clean tree), or what it threw.
 */
export type CommitOutcome = { change: Change | null } | { threw: unknown };

/**
 * Whether a commit attempt LANDED — the one rule every committer applies
 * before announcing a batch to the file-change reactors (see
 * `IVersionControlService.announceCommitted`), kept here so no caller
 * re-derives it: the commit landed when `commitChanges` answered a change,
 * or when it threw the push hand-off — the commit exists on the branch and
 * only its push is owed to the pending-commits worker, which announces
 * nothing of its own. A clean tree (null) and any other error did not land,
 * and announce nothing. WHEN to announce stays the caller's: after its locks
 * or its turn are given back, since a reactor may take a fresh lock on a
 * changed path.
 */
export function commitLanded(outcome: CommitOutcome): boolean {
  if ('threw' in outcome) return outcome.threw instanceof PushNeedsAgentResolutionError;
  return outcome.change !== null;
}
