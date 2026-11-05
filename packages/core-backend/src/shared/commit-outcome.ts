import type { Change } from '@bevel-software/platform-shared';
import { PushNeedsAgentResolutionError } from './domain-errors.js';

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
