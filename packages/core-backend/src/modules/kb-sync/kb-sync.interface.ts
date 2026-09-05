import type { BranchSyncOutcome } from '@bevel-software/platform-shared';

/**
 * Remote sync: a git host (Azure DevOps, GitHub, GitLab, a pipeline) tells
 * Hexis "the repository changed" and Hexis brings the clones it holds up to
 * date. The module owns the HTTP surface, the credential check, the payload
 * parsing and the coalescing; every git operation happens behind the
 * workflow port below, never here.
 */

/** Which branches a caller asked to sync. `'all'` = every clone Hexis holds. */
export interface SyncRequest {
  branches: string[] | 'all';
  /** Who asked — a credential kind or an admin's email — for the last-sync record. */
  by?: string;
}

/**
 * What the most recent sync did, for the admin's Deployment page. Kept in
 * memory only: it answers "is the hook wired up and working?", and a restart
 * resetting it to "none yet" is the honest answer for a fresh process.
 */
export interface LastSync {
  /** Epoch ms when the sync finished. */
  at: number;
  by: string;
  status: SyncResult['status'];
  /** One entry per branch, as the response carried them. */
  results: BranchSyncOutcome[];
}

export interface SyncResult {
  /** `synced` when no branch needs a person or a retry; `partial` otherwise. */
  status: 'synced' | 'partial';
  results: BranchSyncOutcome[];
  changeRequests: {
    /** Open change requests closed because one of their branches is gone from the host. */
    closedDeletedBranch: number;
  };
}

export interface IKbSyncService {
  /**
   * Sync the requested branches. One sync runs at a time; a request arriving
   * mid-run is folded into a single queued follow-up (the union of every
   * request that arrived meanwhile) and resolves with that follow-up's result.
   * Never rejects for a per-branch failure — those are outcomes.
   */
  sync(request: SyncRequest): Promise<SyncResult>;
  /** The most recent completed sync in this process, or null before the first. */
  lastSync(): LastSync | null;
}

/** The slice of the workflow module a sync drives. */
export interface SyncWorkflowPort {
  syncWorkspaceFromRemote(workspaceId: string): Promise<BranchSyncOutcome>;
  /**
   * Retire the clone of a branch the host deleted, under the branch-lifecycle
   * lock and only if origin still lacks it. Returns whether it was removed.
   */
  retireRemoteGoneClone(workspaceId: string): Promise<boolean>;
  /** The existing sweep; returns how many requests it closed. */
  closeChangeRequestsWithDeletedBranches(): Promise<number>;
}

/**
 * The slice of the workspace module a sync reads: which clones exist ON
 * DISK. Not the in-memory "seen this process" cache — clones survive a
 * restart and a hook that fires before anyone has opened a branch must still
 * find them.
 */
export interface SyncWorkspacePort {
  /**
   * `unreadable` names a clone the listing could see but not probe (an ACL,
   * a half-deleted directory); the sync reports it as that branch's error
   * rather than letting one bad directory fail every other branch.
   */
  listClonedWorkspaces(): Promise<Array<{ id: string; branch: string; unreadable?: string }>>;
}
