import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffPayload, ReviewSession } from '@bevel-software/shared';
import type { ReviewContextValue } from '../state/review.context';
import {
  acceptReviewChange,
  fetchReviewFile,
  fetchReviewSession,
  rejectReviewChange,
} from '../services/review.api';

/**
 * Return a copy of `session` with `path` removed from its changes, or `null`
 * when that empties the list. Drives the optimistic reject — the row leaves
 * the panel immediately, before the background commit confirms.
 */
function sessionWithout(session: ReviewSession | null, path: string): ReviewSession | null {
  if (!session) return null;
  const changes = session.changes.filter((c) => c.path !== path);
  return changes.length === 0 ? null : { ...session, changes };
}

export function useReviewState(
  workspaceId: string | null,
  branchName: string | null,
): ReviewContextValue {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffPayload | null>(null);
  const [isLoadingDiff, setIsLoadingDiff] = useState(false);
  // Start `true` when inputs are present: the mount effect will fetch, and we
  // must not let callers (e.g. ShareChangesButton) read `session === null` as
  // "no pending review" during the first render before the fetch resolves.
  const [isLoading, setIsLoading] = useState(() => !!(workspaceId && branchName));
  const [lastError, setLastError] = useState<string | null>(null);

  // Avoid stale responses racing a workspace/branch swap.
  const workspaceIdRef = useRef(workspaceId);
  const branchNameRef = useRef(branchName);
  const sessionSeqRef = useRef(0);
  const fileSeqRef = useRef(0);
  useEffect(() => { workspaceIdRef.current = workspaceId; }, [workspaceId]);
  useEffect(() => { branchNameRef.current = branchName; }, [branchName]);

  const refresh = useCallback(async () => {
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) {
      setSession(null);
      // Release both loading flags so consumers don't stay blocked forever when
      // there's nothing to fetch (e.g. not signed in yet). `isLoadingDiff`
      // matters most here: an in-flight `selectPath` from the previous inputs
      // can no longer clear it from its own `finally` (the `isLatest()` guard
      // will fail after the ref swap), so it would otherwise stick at `true`.
      setIsLoading(false);
      setIsLoadingDiff(false);
      return;
    }
    const token = ++sessionSeqRef.current;
    const isLatest = () =>
      workspaceIdRef.current === wid &&
      branchNameRef.current === branch &&
      sessionSeqRef.current === token;
    setIsLoading(true);
    try {
      const next = await fetchReviewSession(wid);
      if (!isLatest()) return;
      setSession(next);
      setLastError(null);
    } catch (err) {
      if (!isLatest()) return;
      setLastError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (isLatest()) setIsLoading(false);
    }
  }, []);

  // Refresh whenever the (workspaceId, branchName) pair changes. Also clear
  // the stale session + selected diff immediately so the previous branch's
  // pending-changes UI doesn't linger while the refetch is in flight — with
  // the backend workspace mutex held during auto-pulls and branch switches,
  // the `GET /review` round-trip can be queued for seconds, and showing the
  // old branch's review panel during that window looks like the switch
  // silently failed. An in-flight `selectPath` from the old inputs is now
  // guaranteed to fail its own `isLatest()` guard, so it can never clear
  // `isLoadingDiff` on its own.
  useEffect(() => {
    setSession(null);
    setSelectedPath(null);
    setFileDiff(null);
    setIsLoadingDiff(false);
    setIsLoading(!!(workspaceId && branchName));
    refresh();
  }, [workspaceId, branchName, refresh]);

  // Clear the stale fileDiff if the selected path disappears from the session.
  useEffect(() => {
    if (!selectedPath || !session) return;
    const stillPresent = session.changes.some(
      (c) => c.path === selectedPath || c.oldPath === selectedPath,
    );
    if (!stillPresent) {
      setSelectedPath(null);
      setFileDiff(null);
    }
  }, [session, selectedPath]);

  const selectPath = useCallback(async (path: string | null) => {
    setSelectedPath(path);
    if (!path) {
      // Bump the token so an in-flight fetch from a previous `selectPath`
      // can't resolve after us and repopulate `fileDiff`. Without this, a
      // slow fetch started before the clear finishes will still pass its
      // `isLatest()` check when it resumes and stomp the cleared state.
      fileSeqRef.current++;
      setFileDiff(null);
      setIsLoadingDiff(false);
      return;
    }
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) return;
    const token = ++fileSeqRef.current;
    const isLatest = () =>
      workspaceIdRef.current === wid &&
      branchNameRef.current === branch &&
      fileSeqRef.current === token;
    setIsLoadingDiff(true);
    try {
      const payload = await fetchReviewFile(wid, path);
      if (!isLatest()) return;
      setFileDiff(payload);
      setLastError(null);
    } catch (err) {
      if (!isLatest()) return;
      setLastError(err instanceof Error ? err.message : 'Unknown error');
      setFileDiff(null);
    } finally {
      if (isLatest()) setIsLoadingDiff(false);
    }
  }, []);

  // The mutation handlers all follow the same pattern: capture (wid, branch)
  // at call time, run the network mutation, then — only if the hook is still
  // pointed at the same (workspaceId, branchName) — apply the returned
  // session to React state. Without this guard, a slow request from the
  // previous branch can resolve after the user has already switched branches
  // and overwrite the new branch's session with stale data.
  const acceptOne = useCallback(async (path: string) => {
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) return;
    try {
      const next = await acceptReviewChange(wid, path);
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setSession(next);
      if (selectedPath === path) {
        setSelectedPath(null);
        setFileDiff(null);
      }
    } catch (err) {
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setLastError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, [selectedPath]);

  // Reject is optimistic: drop the row from the session immediately so it
  // feels instant, then run the commit + push in the background. The effect
  // above clears `selectedPath`/`fileDiff` if the rejected file was the one
  // on screen. On failure, reconcile the panel back to the true server state
  // (`refresh`) and *then* surface the error — `refresh` clears `lastError`
  // on success, so setting it afterwards is what makes the banner stick.
  const rejectOne = useCallback(async (path: string) => {
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) return;
    setSession((prev) => sessionWithout(prev, path));
    try {
      await rejectReviewChange(wid, path);
    } catch (err) {
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      await refresh();
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setLastError(err instanceof Error ? err.message : 'Reverting failed');
    }
  }, [refresh]);

  const acceptAll = useCallback(async () => {
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) return;
    try {
      const next = await acceptReviewChange(wid);
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setSession(next);
      setSelectedPath(null);
      setFileDiff(null);
    } catch (err) {
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setLastError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  // Optimistic, like `rejectOne`: clear the panel immediately, run the
  // per-file commits + pushes in the background, reconcile + surface on failure.
  const rejectAll = useCallback(async () => {
    const wid = workspaceIdRef.current;
    const branch = branchNameRef.current;
    if (!wid || !branch) return;
    setSession(null);
    setSelectedPath(null);
    setFileDiff(null);
    try {
      await rejectReviewChange(wid);
    } catch (err) {
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      await refresh();
      if (workspaceIdRef.current !== wid || branchNameRef.current !== branch) return;
      setLastError(err instanceof Error ? err.message : 'Reverting failed');
    }
  }, [refresh]);

  const clearError = useCallback(() => setLastError(null), []);

  return useMemo(
    () => ({
      session,
      selectedPath,
      fileDiff,
      isLoadingDiff,
      isLoading,
      lastError,
      refresh,
      selectPath,
      acceptOne,
      rejectOne,
      acceptAll,
      rejectAll,
      clearError,
    }),
    [
      session,
      selectedPath,
      fileDiff,
      isLoadingDiff,
      isLoading,
      lastError,
      refresh,
      selectPath,
      acceptOne,
      rejectOne,
      acceptAll,
      rejectAll,
      clearError,
    ],
  );
}
