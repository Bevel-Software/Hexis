import { useEffect, useRef, useState } from 'react';
import { readFileAtForkPoint } from '../services/change-requests.api';
import { describeReadFailure } from '../services/denied-file.api';
import type { BranchFileRead } from './useFileOnBranch';

const PENDING: BranchFileRead = { content: null, failed: false };

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
 *
 * `opts.targetBranch` is the branch the fork point belongs to — the tree the
 * route checks read authority against, and so the tree to name a folder from
 * when it refuses. `opts.revision` re-reads a key the caller wants tried
 * again; it is what the pane's Retry link moves.
 */
export function useForkPointFileRead(
  crNumber: number,
  sha: string | null,
  repoRelativePath: string | null,
  opts: { targetBranch?: string; revision?: number } = {},
): BranchFileRead {
  const { targetBranch = '', revision = 0 } = opts;
  const [settled, setSettled] = useState<ReadonlyMap<string, BranchFileRead>>(new Map());
  /** Keys already requested — read and written only inside the effect. */
  const asked = useRef<Set<string>>(new Set());
  const key = `${crNumber}::${sha ?? ''}::${repoRelativePath ?? ''}::${revision}`;

  useEffect(() => {
    if (!sha || !repoRelativePath || asked.current.has(key)) return;
    asked.current.add(key);
    const land = (read: BranchFileRead) => setSettled((m) => new Map(m).set(key, read));
    readFileAtForkPoint(crNumber, sha, repoRelativePath)
      .then(({ content }) =>
        land(
          content === null
            ? {
                content: null,
                failed: true,
                // Not a refusal and not an outage: the path simply is not in
                // the text the author started from. Said as the reason, and
                // left retryable — another attempt costs one read and the
                // fork point can move under an Update.
                failure: {
                  kind: 'error',
                  reason: "it wasn't there at the change request's starting point",
                },
              }
            : { content, failed: false },
        ),
      )
      .catch((err: unknown) =>
        describeReadFailure(err, targetBranch, repoRelativePath).then((failure) =>
          land({ content: null, failed: true, failure }),
        ),
      );
  }, [crNumber, sha, repoRelativePath, targetBranch, key]);

  if (!sha || !repoRelativePath) return PENDING;
  return settled.get(key) ?? PENDING;
}
