import { useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { readFileAtForkPoint, readFileOnBranch, type ForkPointFile } from '../services/change-requests.api';
import { PR_STALE_EVENT } from '../../../core/events';
import { isBinaryFile } from '../../workspace/components/renderers';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';
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
 * Branch reads are keyed by CR number + path + revision so a tab switch or a
 * reload can never show the previous file's diff under this file's heading.
 * Fork reads are keyed by number + path alone: resolving a fork point costs
 * the server two branch fetches and a `merge-base` per box, and a revision
 * bump (a tab switch, an apply elsewhere on the page) does not move any
 * request's fork point. The one thing that does — an Update — announces
 * itself with {@link PR_STALE_EVENT}, which re-reads them.
 *
 * Per request: the diff; `[]` when the proposal has been overtaken; `null`
 * while a read is in flight; `'unreadable'` when a read failed, so the box
 * can say so instead of loading forever.
 */
export type CrFileDiff = DiffLine[] | null | 'unreadable';

export function useCrFileDiffs(
  crs: PullRequestSummary[],
  repoRelativePath: string,
  mainRaw: string | null,
  revision = 0,
): Map<number, CrFileDiff> {
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [forkReads, setForkReads] = useState<Map<string, ForkPointFile>>(new Map());
  /** Keys whose branch or fork read failed — no comparison is coming. */
  const [failed, setFailed] = useState<Set<string>>(new Set());
  /** Requests already made, so a failed read is not retried on every render. */
  const asked = useRef<Set<string>>(new Set());
  const forkAsked = useRef<Set<string>>(new Set());
  /**
   * Bumped when something moved a request — an apply, a cancel, an Update —
   * which is the only way a fork point changes under an open page.
   */
  const [forkEpoch, setForkEpoch] = useState(0);
  useEffect(() => {
    const onStale = () => {
      forkAsked.current.clear();
      setForkEpoch((e) => e + 1);
    };
    window.addEventListener(PR_STALE_EVENT, onStale);
    return () => window.removeEventListener(PR_STALE_EVENT, onStale);
  }, []);

  // Only the change requests that actually touch this file have anything to show.
  const relevant = useMemo(
    () => crs.filter((c) => c.touchedNodePaths.includes(repoRelativePath)),
    [crs, repoRelativePath],
  );
  const key = (n: number) => `${n}::${repoRelativePath}::${revision}`;
  const forkKey = (n: number) => `${n}::${repoRelativePath}`;
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
        .catch((err: unknown) => {
          // A 404 is the branch's own answer that the file is not there: the
          // request DELETES it, and every line removed is exactly its diff.
          if (err instanceof WorkspaceApiError && err.status === 404) {
            setContents((m) => new Map(m).set(k, ''));
            return;
          }
          // Anything else is deliberately NOT `''`. Storing empty for an
          // unreadable branch copy would diff as "every line deleted" and
          // present a proposal to erase the file. No content means no claim:
          // the box says it couldn't read.
          setFailed((s) => new Set(s).add(k));
        });
    }
    for (const cr of relevant) {
      const fk = forkKey(cr.number);
      if (forkAsked.current.has(fk)) continue;
      forkAsked.current.add(fk);
      readFileAtForkPoint(cr.number, null, repoRelativePath)
        .then((read) =>
          setForkReads((m) => new Map(m).set(fk, read)),
        )
        .catch(() => {
          // Same rule for the before side: an unreadable fork point is no
          // claim, and falling back to main would bring back the very
          // "deletions" this reads the fork point to avoid.
          setFailed((s) => new Set(s).add(fk));
        });
    }
    // `contents` is intentionally out: it changes on every arrival, and the
    // `asked` guard already makes each (cr, file, revision) fetch once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, repoRelativePath, revision, forkEpoch]);

  return useMemo(() => {
    const out = new Map<number, CrFileDiff>();
    for (const cr of relevant) {
      if (failed.has(key(cr.number)) || failed.has(forkKey(cr.number))) {
        out.set(cr.number, 'unreadable');
        continue;
      }
      const branchRaw = contents.get(key(cr.number));
      const fork = forkReads.get(forkKey(cr.number));
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
  }, [relevant, contents, forkReads, failed, mainRaw, repoRelativePath, revision]);
}
