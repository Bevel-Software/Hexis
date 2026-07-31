import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PullRequestDetail } from '@bevel-software/platform-shared';
import type { PrViewerContextValue } from '../state/pr-viewer.context';
import { fetchPrDetail } from '../services/pr-detail.api';
import { GitApiError } from '../../git/services/git.api';
import { useEventBus } from '../../workflow/state/event-bus.context';

export function usePrViewerState(): PrViewerContextValue {
  const [openPrNumber, setOpenPrNumber] = useState<number | null>(null);
  const [detail, setDetail] = useState<PullRequestDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  // Ignore responses for a PR the user has already closed or swapped away
  // from. Kept synchronously in sync with `openPrNumber` by openPr/closeViewer —
  // NOT via a useEffect, because effects run after the commit phase, and a
  // stale in-flight fetch can resolve between `setOpenPrNumber(n)` and the
  // effect firing. In that window `isLatest()` would still read the previous
  // ref and accept the stale response. Every update path to `openPrNumber`
  // must therefore update this ref first.
  const openPrRef = useRef<number | null>(null);
  const fetchSeqRef = useRef(0);

  const loadDetail = useCallback(
    async (
      prNumber: number,
      opts: { fresh?: boolean; preserveDetailOnError?: boolean } = {},
    ) => {
      const token = ++fetchSeqRef.current;
      const isLatest = () => openPrRef.current === prNumber && fetchSeqRef.current === token;
      setIsLoading(true);
      setLastError(null);
      setNotFound(false);
      try {
        const next = await fetchPrDetail(prNumber, { fresh: opts.fresh });
        if (!isLatest()) return;
        setDetail(next);
        // Auto-select the first file so the diff pane isn't blank. Only on initial
        // load — a refresh shouldn't snap the user back to file 0.
        setSelectedPath((prev) => {
          if (prev && next.files.some((f) => f.path === prev)) return prev;
          return next.files[0]?.path ?? null;
        });
      } catch (err) {
        if (!isLatest()) return;
        // A 404 means the CR row is gone (merged-and-cleaned-up, removed, or a
        // routine deep-linking a stale CR number). That's an expected, benign
        // outcome — surface it as a calm "no longer available" state, not an
        // alarming error. Any other status is a real failure worth showing +
        // retrying.
        const gone = err instanceof GitApiError && err.status === 404;
        setNotFound(gone);
        setLastError(err instanceof Error ? err.message : 'Unknown error');
        // Initial load / PR swap nulls the stale detail so the viewer falls
        // back to its error state. Refreshes preserve the currently-rendered
        // detail — a transient network blip shouldn't wipe out the PR the
        // user was already reading.
        if (!opts.preserveDetailOnError) setDetail(null);
      } finally {
        if (isLatest()) setIsLoading(false);
      }
    },
    [],
  );

  // Fetch whenever the open PR number changes (including on close → null).
  useEffect(() => {
    if (openPrNumber === null) {
      setDetail(null);
      setSelectedPath(null);
      setIsLoading(false);
      setLastError(null);
      setNotFound(false);
      return;
    }
    // Clear the previous PR's state synchronously so the viewer doesn't flash
    // PR A's header/file list while PR B is still loading. `loadDetail` sets
    // isLoading itself, but it only nulls `detail` on failure — on success it
    // overwrites, which leaves the stale detail visible until the fetch
    // resolves.
    setDetail(null);
    setSelectedPath(null);
    setLastError(null);
    setNotFound(false);
    setIsLoading(true);
    loadDetail(openPrNumber);
  }, [openPrNumber, loadDetail]);

  const openPr = useCallback((prNumber: number) => {
    openPrRef.current = prNumber;
    setOpenPrNumber(prNumber);
  }, []);

  const closeViewer = useCallback(() => {
    openPrRef.current = null;
    setOpenPrNumber(null);
  }, []);

  const selectPath = useCallback((path: string | null) => {
    setSelectedPath(path);
  }, []);

  const refresh = useCallback(async () => {
    const current = openPrRef.current;
    if (current === null) return;
    await loadDetail(current, { fresh: true, preserveDetailOnError: true });
  }, [loadDetail]);

  // Refresh the open CR detail when the workflow bus signals that this CR
  // mutated server-side: someone added/removed an approval, merged it, or
  // rejected it. We skip the refresh when the viewer is closed
  // (`openPrRef.current === null`) — there's nothing to refresh. Merge and
  // reject events drive the same `refresh` call because the detail-fetch
  // returns the new `state` (merged / closed) which the viewer renders
  // appropriately; we don't need a different code path per event kind.
  const bus = useEventBus();
  useEffect(() => {
    if (!bus) return;
    const triggerIfMatching = (number: number) => {
      if (openPrRef.current !== number) return;
      void refresh();
    };
    const offApproval = bus.subscribe('approval-changed', (e) => triggerIfMatching(e.number));
    const offMerged = bus.subscribe('change-request-merged', (e) => triggerIfMatching(e.number));
    const offRejected = bus.subscribe('change-request-rejected', (e) => triggerIfMatching(e.number));
    return () => {
      offApproval();
      offMerged();
      offRejected();
    };
  }, [bus, refresh]);

  return useMemo(
    () => ({
      openPrNumber,
      detail,
      selectedPath,
      isLoading,
      lastError,
      notFound,
      openPr,
      closeViewer,
      selectPath,
      refresh,
    }),
    [openPrNumber, detail, selectedPath, isLoading, lastError, notFound, openPr, closeViewer, selectPath, refresh],
  );
}
