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
 * The TARGET branch's text is the "before" in exactly one case: branches with
 * no shared history have no fork point to read, and the target's tip is the
 * only text left. That read is made HERE — against the request's own
 * `base`, which is not always the default branch — and only once a fork read
 * comes back without a fork point, so it carries the same generation as the
 * two sides it joins. A copy passed in from the page would keep whatever
 * moment the page last read it at, and pair a fresh branch copy with a stale
 * target.
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
  const targetAsked = useRef<Set<string>>(new Set());
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
      targetAsked.current.clear();
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
  /**
   * The fallback read is keyed by the TARGET BRANCH, not just the path: a
   * request does not have to target the default branch, and two requests on
   * one file can aim at different ones. Keying by path alone served whichever
   * target happened to be read first to every no-history request on the file.
   */
  const targetKey = (base: string) => `target:${base}::${repoRelativePath}::${staleEpoch}`;
  const wanted = relevant.map((c) => `${c.number}|${c.branch}`).join(',');

  /**
   * Exactly the keys the CURRENT generation reads under. Held in a ref and
   * refreshed before the reads are started, because the alternative — each
   * callback testing against the generation it closed over — lets a slow read
   * from an older generation prune the newer one's answers on arrival, and
   * the `asked` guard then never fetches them again: a box loading forever.
   * Anything not in this set is either a generation that has passed or a
   * request that is no longer on this file, and neither is worth keeping.
   */
  const liveKeys = useRef<Set<string>>(new Set());
  const live = (k: string) => liveKeys.current.has(k);
  const prunedMap = <V,>(m: Map<string, V>) => new Map([...m].filter(([k]) => live(k)));
  const prunedSet = (s: Set<string>) => new Set([...s].filter(live));
  useEffect(() => {
    liveKeys.current = new Set([
      ...relevant.map((cr) => key(cr.number)),
      ...relevant.map((cr) => forkKey(cr.number)),
      ...relevant.map((cr) => targetKey(cr.base)),
    ]);
    // Declared BEFORE the read effect so it has already run when those reads
    // are started, and so before any of their answers can arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, repoRelativePath, revision, staleEpoch]);

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
    for (const set of [asked.current, forkAsked.current, targetAsked.current]) {
      for (const k of [...set]) if (!live(k)) set.delete(k);
    }
    for (const cr of relevant) {
      const k = key(cr.number);
      if (asked.current.has(k)) continue;
      asked.current.add(k);
      readFileOnBranch(cr.branch, repoRelativePath)
        .then((content) => {
          if (live(k)) setContents((m) => prunedMap(m).set(k, content));
        })
        .catch((err: unknown) => {
          if (!live(k)) return;
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
          if (!live(fk)) return;
          setForkReads((m) => prunedMap(m).set(fk, read));
          // No fork point (no shared history): main's tip is the only "before"
          // left, and it is read now, under this generation's key.
          const tk = targetKey(cr.base);
          if (read.forkSha === null && !targetAsked.current.has(tk)) {
            targetAsked.current.add(tk);
            readFileOnBranch(cr.base, repoRelativePath)
              .then((content) => {
                if (live(tk)) setContents((m) => prunedMap(m).set(tk, content));
              })
              .catch((err: unknown) => {
                if (!live(tk)) return;
                // Absent on the target is a real answer: the request adds the file.
                if (err instanceof WorkspaceApiError && err.status === 404) {
                  setContents((m) => prunedMap(m).set(tk, ''));
                  return;
                }
                setFailed((s) => prunedSet(s).add(tk));
              });
          }
        })
        .catch(() => {
          if (!live(fk)) return;
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
        (noSharedHistory && failed.has(targetKey(cr.base)))
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
            ? (contents.get(targetKey(cr.base)) ?? null)
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
