import { useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { readFileOnBranch } from '../services/change-requests.api';
import { diffLines, hasChanges, type DiffLine } from '../utils/diff';

/**
 * For each open change request touching `repoRelativePath`, that branch's copy
 * of the file diffed against the file as it stands on the default branch.
 *
 * Against CURRENT main, not against what the author forked from: the person
 * deciding is being asked "should this text become that text?", and the only
 * honest answer to that compares the proposal with what is there right now.
 *
 * Keyed by CR number + path + revision so a tab switch or a reload can never
 * show the previous file's diff under this file's heading.
 */
export function useCrFileDiffs(
  crs: PullRequestSummary[],
  repoRelativePath: string,
  mainRaw: string | null,
  revision = 0,
): Map<number, DiffLine[] | null> {
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  /** Requests already made, so a failed read is not retried on every render. */
  const asked = useRef<Set<string>>(new Set());

  // Only the change requests that actually touch this file have anything to show.
  const relevant = useMemo(
    () => crs.filter((c) => c.touchedNodePaths.includes(repoRelativePath)),
    [crs, repoRelativePath],
  );
  const key = (n: number) => `${n}::${repoRelativePath}::${revision}`;
  const wanted = relevant.map((c) => `${c.number}|${c.branch}`).join(',');

  /**
   * No `cancelled` flag — see `useDefaultBranchFile` for why one would deadlock
   * against the `asked` guard under StrictMode. Stale answers are discarded by
   * the KEY (cr + path + revision), not by cleanup.
   */
  useEffect(() => {
    for (const cr of relevant) {
      const k = key(cr.number);
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      readFileOnBranch(cr.branch, repoRelativePath)
        .then((content) => setContents((m) => new Map(m).set(k, content)))
        .catch(() => {
          // Deliberately NOT `''`. Storing empty for an unreadable branch copy
          // would diff as "every line deleted" and present a proposal to erase
          // the file. No content means no claim: the box keeps waiting.
        });
    }
    // `contents` is intentionally out: it changes on every arrival, and the
    // `asked` guard already makes each (cr, file, revision) fetch once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, repoRelativePath, revision]);

  return useMemo(() => {
    const out = new Map<number, DiffLine[] | null>();
    for (const cr of relevant) {
      const branchRaw = contents.get(key(cr.number));
      if (mainRaw === null || branchRaw === undefined) {
        out.set(cr.number, null);
        continue;
      }
      const d = diffLines(mainRaw, branchRaw);
      // A proposal whose text now matches main has been overtaken — showing an
      // empty diff would ask for a decision about nothing.
      out.set(cr.number, hasChanges(d) ? d : []);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevant, contents, mainRaw, repoRelativePath, revision]);
}
