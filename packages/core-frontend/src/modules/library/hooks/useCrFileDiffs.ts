import { useEffect, useMemo, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { readFileOnBranch } from '../services/library.api';
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

  // Only the change requests that actually touch this file have anything to show.
  const relevant = useMemo(
    () => crs.filter((c) => c.touchedNodePaths.includes(repoRelativePath)),
    [crs, repoRelativePath],
  );
  const key = (n: number) => `${n}::${repoRelativePath}::${revision}`;
  const wanted = relevant.map((c) => `${c.number}|${c.branch}`).join(',');

  useEffect(() => {
    let cancelled = false;
    for (const cr of relevant) {
      const k = key(cr.number);
      if (contents.has(k)) continue;
      readFileOnBranch(cr.branch, repoRelativePath)
        .then((content) => {
          if (!cancelled) setContents((m) => new Map(m).set(k, content));
        })
        .catch(() => {
          // Unreadable branch: record the miss so it is not retried in a loop.
          if (!cancelled) setContents((m) => new Map(m).set(k, ''));
        });
    }
    return () => {
      cancelled = true;
    };
    // `contents` is intentionally out: it changes on every arrival, and the
    // `has` guard above already makes each (cr, file, revision) fetch once.
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
