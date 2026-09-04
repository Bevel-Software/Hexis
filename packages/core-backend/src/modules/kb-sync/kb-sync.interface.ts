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
}

/** The slice of the workflow module a sync drives. */
export interface SyncWorkflowPort {
  syncWorkspaceFromRemote(workspaceId: string): Promise<BranchSyncOutcome>;
  /** The existing sweep; returns how many requests it closed. */
  closeChangeRequestsWithDeletedBranches(): Promise<number>;
}

/** The slice of the workspace module a sync reads: which clones exist. */
export interface SyncWorkspacePort {
  knownWorkspaces(): Array<{ id: string; branch: string }>;
}
