import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BranchInfo,
  CommitAttribution,
  WorkingTreeStatus,
} from '@bevel-software/platform-shared';
import type { GitContextValue } from '../state/git.context';
import {
  createBranch as apiCreateBranch,
  deleteBranch as apiDeleteBranch,
  fetchBranches,
  fetchFileComparison,
  fetchFileDiff,
  fetchFileHistory,
  fetchForkBase,
  fetchStatus,
  pull as apiPull,
  revert as apiRevert,
} from '../services/git.api';

const STATUS_POLL_MS = 30_000;

export function useGitState(workspaceId: string | null): GitContextValue {
  const [status, setStatus] = useState<WorkingTreeStatus | null>(null);
  const [rawBranches, setRawBranches] = useState<BranchInfo[]>([]);
  // Names of branches whose delete is in flight. Filtered out of the exposed
  // `branches` so the row vanishes from the picker the instant the user
  // confirms, before `git push --delete origin <name>` resolves. The set
  // survives any concurrent `refreshBranches()` that lands mid-flight — the
  // server still reports the branch as present until the delete commits,
  // and without this filter the row would briefly reappear.
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(new Set());
  const [availability, setAvailability] = useState<GitContextValue['availability']>('loading');
  const [lastError, setLastError] = useState<string | null>(null);
  const branches = useMemo(
    () => rawBranches.filter((b) => !pendingDeletes.has(b.name)),
    [rawBranches, pendingDeletes],
  );

  // Pin the latest workspaceId for async callbacks so we ignore stale responses.
  const workspaceIdRef = useRef(workspaceId);
  useEffect(() => {
    workspaceIdRef.current = workspaceId;
  }, [workspaceId]);

  // Per-refresh sequence counters: two in-flight requests for the *same* workspace can
  // still resolve out of order (e.g. after a polling tick overlaps a manual refresh), so
  // workspaceId alone isn't sufficient — we also need to drop any response whose token
  // is no longer the latest.
  const statusSeqRef = useRef(0);
  const branchesSeqRef = useRef(0);
  const remoteRefreshInFlightRef = useRef(false);
  // Set when a refresh is requested while one is already in flight. After the
  // current refresh finishes we run exactly one more, so a workspace switch
  // (or any other caller) that lands during an in-flight poll still gets
  // immediate fresh data instead of waiting for the next 30s tick.
  const pendingRefreshRef = useRef(false);

  const refreshStatus = useCallback(async (): Promise<WorkingTreeStatus | null> => {
    const wid = workspaceIdRef.current;
    if (!wid) return null;
    const token = ++statusSeqRef.current;
    const isLatest = () => workspaceIdRef.current === wid && statusSeqRef.current === token;
    try {
      const s = await fetchStatus(wid);
      if (!isLatest()) return null;
      setStatus(s);
      setAvailability('ready');
      setLastError(null);
      return s;
    } catch (err) {
      if (!isLatest()) return null;
      setAvailability('error');
      setLastError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, []);

  const refreshBranches = useCallback(async (opts: { fresh?: boolean } = {}) => {
    const wid = workspaceIdRef.current;
    if (!wid) return;
    const token = ++branchesSeqRef.current;
    const isLatest = () => workspaceIdRef.current === wid && branchesSeqRef.current === token;
    try {
      const bs = await fetchBranches(wid, opts);
      if (!isLatest()) return;
      setRawBranches(bs);
    } catch (err) {
      if (!isLatest()) return;
      setLastError(err instanceof Error ? err.message : 'Unknown error');
    }
  }, []);

  /**
   * User-invoked `git pull --rebase` against origin. Surfaces errors to the
   * caller. On protected branches the API guards block local commits, so a
   * clean working tree fast-forwards; a dirty tree (mid-flow agent edit) or
   * any non-fast-forward situation makes git refuse the rebase and we throw
   * — the PullNeededBanner uses that to fall back to seeding the agent
   * prompt. Status + branches are refreshed even on failure so the UI
   * reflects whatever state the backend ended up in.
   */
  const pull = useCallback(async () => {
    const wid = workspaceIdRef.current;
    if (!wid) throw new Error('No workspace loaded');
    try {
      await apiPull(wid);
    } finally {
      if (workspaceIdRef.current === wid) {
        await Promise.all([refreshStatus(), refreshBranches()]);
      }
    }
  }, [refreshStatus, refreshBranches]);

  /**
   * Refresh remote-tracking refs before checking status so the app can notice
   * teammate commits that landed after the workspace was opened. `listBranches`
   * performs the fetch server-side and swallows network/auth failures, so the
   * status poll keeps serving local state when origin is temporarily unavailable.
   */
  const refreshRemoteState = useCallback(async () => {
    if (!workspaceIdRef.current) return;
    if (remoteRefreshInFlightRef.current) {
      // Coalesce concurrent calls into a single follow-up. Without this, a
      // workspace switch during an in-flight refresh would silently drop the
      // new workspace's initial fetch.
      pendingRefreshRef.current = true;
      return;
    }
    remoteRefreshInFlightRef.current = true;
    // Loop instead of recursing so the trailing follow-up always reads the
    // latest workspaceIdRef, without needing the callback to depend on itself.
    do {
      pendingRefreshRef.current = false;
      const wid = workspaceIdRef.current;
      if (!wid) break;
      try {
        // Status is a cheap local call and is the ONLY thing the branch
        // switcher's mid-switch label waits on — fire it up front so it
        // resolves in a single round-trip instead of queuing behind the
        // branch-list fetch (which carries a slow server-side `git fetch`).
        const initialStatus = refreshStatus();
        // `refreshBranches` performs that server-side fetch, refreshing
        // origin's remote-tracking refs. Run it concurrently; once it lands,
        // refresh status again so `unmergedFromUpstream` reflects the
        // freshly-fetched refs (the reason the two were ordered
        // branches-then-status before).
        const branchesThenStatus = refreshBranches().then(() => {
          if (workspaceIdRef.current === wid) return refreshStatus();
        });
        await Promise.all([initialStatus, branchesThenStatus]);
      } catch {
        // refreshBranches/refreshStatus already record their own errors;
        // swallow here so a transient failure doesn't strand the in-flight
        // flag and block the queued follow-up.
      }
    } while (pendingRefreshRef.current);
    remoteRefreshInFlightRef.current = false;
  }, [refreshBranches, refreshStatus]);

  // Initial load + polling.
  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      setRawBranches([]);
      setPendingDeletes(new Set());
      setAvailability('loading');
      return;
    }
    setAvailability('loading');
    refreshRemoteState();

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        refreshRemoteState();
      }
    }, STATUS_POLL_MS);
    return () => window.clearInterval(interval);
  }, [workspaceId, refreshRemoteState]);

  // No `switchBranch` here on purpose. Under the per-branch workspace model
  // (`workspaces/<encodeURIComponent(branch)>/`), switching branches is a
  // pure UI navigation: the URL changes, FileRoute calls setPersistenceBranch,
  // useWorkspaceState bootstraps the destination workspace (cloning at the
  // requested branch if needed), workspaceId here updates, and the polling
  // effect above re-fetches status against the new workspace. No git op runs
  // on the source workspace's clone, so there is no dirty-tree gate to trip
  // and no race between "switch the agent's branch" and "switch the UI's
  // branch". The legacy `git.switchBranch` API + frontend callback have
  // been removed; everything goes through the URL → workspaceId pipeline.

  const createBranch = useCallback(
    async (name: string, fromBase?: string): Promise<void> => {
      const wid = workspaceIdRef.current;
      if (!wid) throw new Error('No workspace loaded');
      // Creating a branch is a write against the current workspace's clone.
      // The caller (BranchSwitcher) navigates to the new branch's URL
      // immediately after, which triggers the workspace bootstrap to clone
      // (or fetch) the new branch into its own per-branch workspace dir.
      await apiCreateBranch(wid, name, fromBase);
      // Refresh branches so the picker reflects the new draft right away,
      // even before the navigation completes its workspace bootstrap.
      await refreshBranches();
    },
    [refreshBranches],
  );

  const deleteBranchCb = useCallback(
    async (name: string, opts: { onlyIfNoRemote?: boolean } = {}): Promise<void> => {
      const wid = workspaceIdRef.current;
      if (!wid) throw new Error('No workspace loaded');
      // Optimistic: hide the row immediately so the user gets instant
      // feedback while `git push --delete origin <name>` runs over the wire.
      // Mirrors the optimistic-mutation pattern in `useReviewState.rejectOne`.
      setPendingDeletes((prev) => {
        if (prev.has(name)) return prev;
        const next = new Set(prev);
        next.add(name);
        return next;
      });
      try {
        await apiDeleteBranch(wid, name, opts);
        // Success: refresh so any concurrent changes (e.g. a teammate pushed
        // a new draft while we were deleting) land in the picker too. The
        // row stays hidden until the `finally` drops it from pendingDeletes,
        // and by then rawBranches no longer includes it — no flicker.
        await refreshBranches();
      } catch (err) {
        // Failure: refresh to put server truth back on rawBranches (which
        // still has the branch). The `finally` then clears pendingDeletes,
        // so the row reappears just as the error propagates to the caller.
        await refreshBranches();
        throw err;
      } finally {
        setPendingDeletes((prev) => {
          if (!prev.has(name)) return prev;
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    },
    [refreshBranches],
  );

  // `forkToDraft` callback removed: equivalent to `createBranch` under
  // save=share + per-branch workspaces. Use the latter and navigate to the
  // new branch's URL.

  const fetchForkBaseCb = useCallback(async (branch: string): Promise<string | null> => {
    const wid = workspaceIdRef.current;
    if (!wid) return null;
    return fetchForkBase(wid, branch);
  }, []);

  const revert = useCallback(
    async (sha: string): Promise<CommitAttribution> => {
      const wid = workspaceIdRef.current;
      if (!wid) throw new Error('No workspace loaded');
      const attribution = await apiRevert(wid, sha);
      await refreshStatus();
      return attribution;
    },
    [refreshStatus],
  );

  const fetchFileHistoryCb = useCallback(
    async (path: string, limit?: number): Promise<CommitAttribution[]> => {
      const wid = workspaceIdRef.current;
      if (!wid) return [];
      return fetchFileHistory(wid, path, limit);
    },
    [],
  );

  const fetchFileDiffCb = useCallback(
    async (path: string, sha: string): Promise<string> => {
      const wid = workspaceIdRef.current;
      if (!wid) return '';
      return fetchFileDiff(wid, path, sha);
    },
    [],
  );

  const fetchFileComparisonCb = useCallback(
    async (path: string, fromBranch: string, toBranch: string): Promise<string> => {
      const wid = workspaceIdRef.current;
      // The contract treats an empty string as "files are identical", so we
      // can't reuse it as a sentinel for "no active workspace" — the panel
      // would render the misleading "identical on both versions" empty
      // state. Reject instead so callers fall into their error branch.
      if (!wid) throw new Error('No active workspace.');
      return fetchFileComparison(wid, path, fromBranch, toBranch);
    },
    [],
  );

  // `fetchWorkingStatusCb` + `fetchWorkingDiffCb` removed: working-tree dirty
  // surface is always empty under save=share.

  return useMemo(
    () => ({
      status,
      branches,
      availability,
      lastError,
      refreshStatus,
      refreshBranches,
      createBranch,
      deleteBranch: deleteBranchCb,
      pull,
      fetchForkBase: fetchForkBaseCb,
      revert,
      fetchFileHistory: fetchFileHistoryCb,
      fetchFileDiff: fetchFileDiffCb,
      fetchFileComparison: fetchFileComparisonCb,
    }),
    [
      status,
      branches,
      availability,
      lastError,
      refreshStatus,
      refreshBranches,
      createBranch,
      deleteBranchCb,
      pull,
      fetchForkBaseCb,
      revert,
      fetchFileHistoryCb,
      fetchFileDiffCb,
      fetchFileComparisonCb,
    ],
  );
}
