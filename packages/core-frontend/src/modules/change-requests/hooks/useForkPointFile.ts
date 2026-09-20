import { useEffect, useRef, useState } from 'react';
import { readFileAtForkPoint } from '../services/change-requests.api';
import type { BranchFileRead } from './useFileOnBranch';

const PENDING: BranchFileRead = { content: null, failed: false };
const FAILED: BranchFileRead = { content: null, failed: true };

/**
 * A file's text at a change request's FORK POINT — where the author started.
 *
 * The request dialog's diffs read their "before" side here rather than on the
 * target as it stands now. Against the tip, anything someone else changed on
 * the target after the proposal shows up inside the proposal as a deletion —
 * a request that appears to undo work its author never saw. Against the fork
 * point the request shows exactly what its author changed; that the target
 * has moved on is said separately, by the dialog's "has changed" notice.
 *
 * `null` sha or path means "don't fetch". Settled reads are kept per key (as
 * `useFileOnBranchRead` does, and for the same no-`cancelled`-flag reason), so
 * flipping between files never shows one file's text under another. A path
 * absent at the fork point settles as a FAILURE: callers only ask for a file
 * the request modifies or moves, so an absent before-side is not an empty file.
 */
export function useForkPointFileRead(
  crNumber: number,
  sha: string | null,
  repoRelativePath: string | null,
): BranchFileRead {
  const [settled, setSettled] = useState<ReadonlyMap<string, BranchFileRead>>(new Map());
  /** Keys already requested — read and written only inside the effect. */
  const asked = useRef<Set<string>>(new Set());
  const key = `${crNumber}::${sha ?? ''}::${repoRelativePath ?? ''}`;

  useEffect(() => {
    if (!sha || !repoRelativePath || asked.current.has(key)) return;
    asked.current.add(key);
    const land = (read: BranchFileRead) => setSettled((m) => new Map(m).set(key, read));
    readFileAtForkPoint(crNumber, sha, repoRelativePath)
      .then(({ content }) => land(content === null ? FAILED : { content, failed: false }))
      .catch(() => land(FAILED));
  }, [crNumber, sha, repoRelativePath, key]);

  if (!sha || !repoRelativePath) return PENDING;
  return settled.get(key) ?? PENDING;
}
