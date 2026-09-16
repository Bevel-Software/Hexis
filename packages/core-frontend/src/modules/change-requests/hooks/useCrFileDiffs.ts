import { useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { readFileAtForkPoint, readFileOnBranch, type ForkPointFile } from '../services/change-requests.api';
import { isBinaryFile } from '../../workspace/components/renderers';
import { diffLines, hasChanges, type DiffLine } from '../utils/diff';

/**
 * For each open change request touching `repoRelativePath`, what THAT REQUEST
 * changes in the file: its branch's copy diffed against the file as it stood
 * at the request's fork point — the text its author started from.
 *
 * Not against current main. Diffing against the tip showed every edit made on
 * main after the proposal as something the proposal DELETES: a reader saw
 * another person's direct edit struck through inside somebody else's request,
 * and feared approving it would undo that edit. (Applying is a merge, and keeps
 * the newer edit.) The request dialog reads the same fork point, so the box and
 * the whole-change view never disagree about what a request does.
 *
 * `mainRaw` is still the "before" in exactly one case: branches with no shared
 * history have no fork point to read, and the tip is the only text left.
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
  const [forkReads, setForkReads] = useState<Map<string, ForkPointFile>>(new Map());
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
    // A binary file has no honest text diff, and line-diffing decoded binary
    // bytes is quadratic enough to hang the tab — never even read it. The
    // boxes render their own binary notice instead of a diff.
    if (isBinaryFile(repoRelativePath)) return;
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
      readFileAtForkPoint(cr.number, null, repoRelativePath)
        .then((read) => setForkReads((m) => new Map(m).set(k, read)))
        .catch(() => {
          // Same rule for the before side: an unreadable fork point is no
          // claim, and falling back to main would bring back the very
          // "deletions" this reads the fork point to avoid.
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
      const fork = forkReads.get(key(cr.number));
      // The before side: the fork point's text; '' when the request ADDS the
      // file (absent at the fork point); main only when there is no fork point.
      const before =
        fork === undefined ? null : fork.forkSha === null ? mainRaw : (fork.content ?? '');
      if (before === null || branchRaw === undefined) {
        out.set(cr.number, null);
        continue;
      }
      const d = diffLines(before, branchRaw);
      // A proposal that no longer changes anything has been overtaken — showing
      // an empty diff would ask for a decision about nothing.
      out.set(cr.number, hasChanges(d) ? d : []);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevant, contents, forkReads, mainRaw, repoRelativePath, revision]);
}
