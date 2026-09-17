import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BRANCH, type PullRequestSummary } from '@bevel-software/platform-shared';
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
 * Main's text is the "before" in exactly one case: branches with no shared
 * history have no fork point to read, and the tip is the only text left. That
 * read is made HERE, and only once a fork read comes back without a fork
 * point, so it carries the same generation as the two sides it joins — a main
 * copy passed in from the page would keep whatever moment the page last read
 * it at, and pair a fresh branch copy with a stale target.
 *
 * Branch reads are keyed by CR number + path + revision so a tab switch or a
 * reload can never show the previous file's diff under this file's heading.
 * Fork reads carry no revision: resolving a fork point costs the server two
 * branch fetches and a `merge-base` per box, and a revision bump (a tab
 * switch, an apply elsewhere on the page) does not move any request's fork
 * point. The one thing that does — an Update — announces itself with
 * {@link PR_STALE_EVENT}.
 *
 * BOTH keys carry that event's epoch, because the two sides of one diff have
 * to describe the same moment. Re-reading only the fork point after an Update
 * paired the merged target's text with the branch copy cached from before the
 * merge, and the target's own newer lines rendered as deletions inside the
 * request — the exact reading this hook exists to prevent, arriving seconds
 * after the Update that was supposed to settle it. Under a new epoch neither
 * side is cached, so a box waits rather than mixing two moments.
 *
 * Each arrival drops what earlier generations left behind, so a page left open
 * through many applies and pulls holds one set of reads, not one per event.
 *
 * Per request: the diff; `[]` when the proposal has been overtaken; `null`
 * while a read is in flight; `'unreadable'` when a read failed, so the box
 * can say so instead of loading forever.
 */
export type CrFileDiff = DiffLine[] | null | 'unreadable';

export function useCrFileDiffs(
  crs: PullRequestSummary[],
  repoRelativePath: string,
  revision = 0,
): Map<number, CrFileDiff> {
  const [contents, setContents] = useState<Map<string, string>>(new Map());
  const [forkReads, setForkReads] = useState<Map<string, ForkPointFile>>(new Map());
  /** Keys whose branch, fork or main read failed — no comparison is coming. */
  const [failed, setFailed] = useState<Set<string>>(new Set());
  /** Requests already made, so a failed read is not retried on every render. */
  const asked = useRef<Set<string>>(new Set());
  const forkAsked = useRef<Set<string>>(new Set());
  const mainAsked = useRef<Set<string>>(new Set());
  /**
   * Bumped when something moved a request — an apply, a cancel, an Update.
   * Both sides are re-read: a request that moved has a new head as well as a
   * new fork point, and half a re-read is a diff between two moments.
   */
  const [staleEpoch, setStaleEpoch] = useState(0);
  useEffect(() => {
    const onStale = () => {
      asked.current.clear();
      forkAsked.current.clear();
      mainAsked.current.clear();
      setStaleEpoch((e) => e + 1);
    };
    window.addEventListener(PR_STALE_EVENT, onStale);
    return () => window.removeEventListener(PR_STALE_EVENT, onStale);
  }, []);

  // Only the change requests that actually touch this file have anything to show.
  const relevant = useMemo(
    () => crs.filter((c) => c.touchedNodePaths.includes(repoRelativePath)),
    [crs, repoRelativePath],
  );
  const key = (n: number) => `${n}::${repoRelativePath}::${revision}::${staleEpoch}`;
  const forkKey = (n: number) => `${n}::${repoRelativePath}::${staleEpoch}`;
  const mainKey = `${repoRelativePath}::${staleEpoch}`;
  const wanted = relevant.map((c) => `${c.number}|${c.branch}`).join(',');

  /**
   * Everything this generation can still read, and nothing else. Applied as
   * each answer lands, which is the only moment new keys appear — so the maps
   * hold the current generation plus, briefly, whatever is still in flight
   * from the one before it.
   */
  const live = (k: string) =>
    k.endsWith(`::${revision}::${staleEpoch}`) || k === mainKey || k.endsWith(`::${staleEpoch}`);
  const prunedMap = <V,>(m: Map<string, V>) => new Map([...m].filter(([k]) => live(k)));
  const prunedSet = (s: Set<string>) => new Set([...s].filter(live));

  /**
   * No `cancelled` flag — see `useDefaultBranchFile` for why one would deadlock
   * against the `asked` guard under StrictMode. Stale answers are discarded by
   * the KEY (cr + path + revision + epoch), not by cleanup.
   */
  useEffect(() => {
    // A binary file has no honest text diff, and line-diffing decoded binary
    // bytes is quadratic enough to hang the tab — never even read it. The
    // boxes render their own binary notice instead of a diff.
    if (isBinaryFile(repoRelativePath)) return;
    // The guards are refs, so they outlive the generation that filled them.
    for (const set of [asked.current, forkAsked.current, mainAsked.current]) {
      for (const k of [...set]) if (!live(k)) set.delete(k);
    }
    for (const cr of relevant) {
      const k = key(cr.number);
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      readFileOnBranch(cr.branch, repoRelativePath)
        .then((content) => setContents((m) => prunedMap(m).set(k, content)))
        .catch((err: unknown) => {
          // A 404 is the branch's own answer that the file is not there: the
          // request DELETES it, and every line removed is exactly its diff.
          if (err instanceof WorkspaceApiError && err.status === 404) {
            setContents((m) => prunedMap(m).set(k, ''));
            return;
          }
          // Anything else is deliberately NOT `''`. Storing empty for an
          // unreadable branch copy would diff as "every line deleted" and
          // present a proposal to erase the file. No content means no claim:
          // the box says it couldn't read.
          setFailed((s) => prunedSet(s).add(k));
        });
    }
    for (const cr of relevant) {
      const fk = forkKey(cr.number);
      if (forkAsked.current.has(fk)) continue;
      forkAsked.current.add(fk);
      readFileAtForkPoint(cr.number, null, repoRelativePath)
        .then((read) => {
          setForkReads((m) => prunedMap(m).set(fk, read));
          // No fork point (no shared history): main's tip is the only "before"
          // left, and it is read now, under this generation's key.
          if (read.forkSha === null && !mainAsked.current.has(mainKey)) {
            mainAsked.current.add(mainKey);
            readFileOnBranch(DEFAULT_BRANCH, repoRelativePath)
              .then((content) => setContents((m) => prunedMap(m).set(mainKey, content)))
              .catch((err: unknown) => {
                // Absent on main is a real answer: the request adds the file.
                if (err instanceof WorkspaceApiError && err.status === 404) {
                  setContents((m) => prunedMap(m).set(mainKey, ''));
                  return;
                }
                setFailed((s) => prunedSet(s).add(mainKey));
              });
          }
        })
        .catch(() => {
          // Same rule for the before side: an unreadable fork point is no
          // claim, and falling back to main would bring back the very
          // "deletions" this reads the fork point to avoid.
          setFailed((s) => prunedSet(s).add(fk));
        });
    }
    // `contents` is intentionally out: it changes on every arrival, and the
    // `asked` guard already makes each (cr, file, revision) fetch once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, repoRelativePath, revision, staleEpoch]);

  return useMemo(() => {
    const out = new Map<number, CrFileDiff>();
    for (const cr of relevant) {
      const fork = forkReads.get(forkKey(cr.number));
      const noSharedHistory = fork !== undefined && fork.forkSha === null;
      if (
        failed.has(key(cr.number)) ||
        failed.has(forkKey(cr.number)) ||
        (noSharedHistory && failed.has(mainKey))
      ) {
        out.set(cr.number, 'unreadable');
        continue;
      }
      const branchRaw = contents.get(key(cr.number));
      // The before side: the fork point's text; '' when the request ADDS the
      // file (absent at the fork point); main only when there is no fork point.
      const before =
        fork === undefined
          ? null
          : noSharedHistory
            ? (contents.get(mainKey) ?? null)
            : (fork.content ?? '');
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
  }, [relevant, contents, forkReads, failed, repoRelativePath, revision, staleEpoch]);
}
