import { createContext, useContext } from 'react';
import type {
  BranchInfo,
  CommitAttribution,
  WorkingTreeStatus,
} from '@bevel-software/platform-shared';

export interface GitContextValue {
  status: WorkingTreeStatus | null;
  branches: BranchInfo[];
  availability: 'loading' | 'error' | 'ready';
  lastError: string | null;
  /**
   * Re-fetch the working-tree status and update the context. Returns the
   * fresh status so callers that need to react to the new value (e.g. a
   * post-chat handler reconciling the URL against an agent-driven branch
   * switch) don't have to wait for React state to flush.
   */
  refreshStatus(): Promise<WorkingTreeStatus | null>;
  /** `fresh` forces a server-side `git fetch --prune`, bypassing the implicit
   *  fetch TTL — use it for user-initiated refreshes (e.g. opening the branch
   *  selector) so remote create/delete from another workspace reflects at once. */
  refreshBranches(opts?: { fresh?: boolean }): Promise<void>;
  /**
   * Create a new draft branch (server-side) and refresh the local branch
   * list. Does NOT change the active branch — the caller is responsible
   * for navigating to the new branch's URL, which triggers the per-branch
   * workspace bootstrap. Under the per-branch workspace model there is no
   * separate "switch" step.
   */
  createBranch(name: string, fromBase?: string): Promise<void>;
  /**
   * Delete a local branch. `onlyIfNoRemote` (default false) gates the call on
   * the remote counterpart being absent — used by the PR-prune flow so we
   * can't nuke a branch still in use by others.
   */
  deleteBranch(name: string, opts?: { onlyIfNoRemote?: boolean }): Promise<void>;
  // `forkToDraft` removed: identical in behaviour to `createBranch` under
  // save=share + per-branch workspaces (no dirty-tree carry-along ever
  // happens). Use `createBranch` and navigate to the new branch's URL.
  /**
   * `git pull --rebase` the current branch from origin, then refresh status
   * and branches. Throws on failure (network, auth, rebase abort) so the
   * caller can surface a message; on success the banner driving this call
   * unmounts automatically once `unmergedFromUpstream` flips to false. Status
   * refresh runs even when the pull fails so the UI reflects the resulting
   * server state. App-level auto-update code calls this only for clean
   * protected branches.
   */
  pull(): Promise<void>;
  /**
   * Resolve which protected branch `branch` was forked from, or null if
   * `branch` is itself protected / can't be resolved.
   */
  fetchForkBase(branch: string): Promise<string | null>;
  fetchFileHistory(path: string, limit?: number): Promise<CommitAttribution[]>;
  fetchFileDiff(path: string, sha: string): Promise<string>;
  /**
   * Full before/after contents of `path` at one commit (`sha^` vs `sha`);
   * null on a side means the file is absent there. The history panel uses
   * this to render markdown changes as a red/green rendered-markdown diff
   * instead of the raw patch `fetchFileDiff` returns.
   */
  fetchFileAtChange(
    path: string,
    sha: string,
  ): Promise<{ baseline: string | null; current: string | null }>;
  /**
   * Unified diff of `path` between two branches. Read-only; nothing is
   * checked out or written. `fromBranch` and `toBranch` must be names from
   * `branches` (local or origin-only). Empty string means the file is
   * identical on both sides.
   */
  fetchFileComparison(
    path: string,
    fromBranch: string,
    toBranch: string,
  ): Promise<string>;
  // `fetchWorkingStatus` + `fetchWorkingDiff` removed: under save=share the
  // working tree is never dirty, so both surfaces always report the empty
  // state. Cross-branch comparison + commit history cover the meaningful
  // diff cases.
}

export const GitContext = createContext<GitContextValue | null>(null);

export function useGit(): GitContextValue {
  const ctx = useContext(GitContext);
  if (!ctx) throw new Error('useGit must be used within GitContext.Provider');
  return ctx;
}
