import type { BranchSyncOutcome } from '@bevel-software/platform-shared';
import type {
  IKbSyncService,
  SyncRequest,
  SyncResult,
  SyncWorkflowPort,
  SyncWorkspacePort,
} from './kb-sync.interface.js';

/**
 * Runs remote syncs one at a time and folds everything that arrives
 * mid-run into ONE follow-up.
 *
 * Why coalesce: a git host fires several hooks for one event — Azure DevOps
 * sends a push, a PR-updated and a PR-merged within a second of each other —
 * and each would otherwise queue behind the workspace mutex to pull the same
 * tree again. The follow-up carries the union of every request that arrived
 * during the run (an "all" absorbs the rest), and every one of those callers
 * receives the follow-up's result, which by then covers their branch.
 *
 * Branches are pulled sequentially. N is small (only cloned branches count),
 * the per-clone mutex serialises them anyway, and one slow origin round-trip
 * at a time keeps the process calm during a burst.
 */
export class KbSyncService implements IKbSyncService {
  private inFlight: Promise<unknown> | null = null;
  private queued: {
    branches: Set<string> | 'all';
    promise: Promise<SyncResult>;
    resolve: (r: SyncResult) => void;
    reject: (e: unknown) => void;
  } | null = null;

  constructor(
    private readonly workflow: SyncWorkflowPort,
    private readonly workspaces: SyncWorkspacePort,
  ) {}

  sync(request: SyncRequest): Promise<SyncResult> {
    if (!this.inFlight) return this.start(request);

    if (!this.queued) {
      let resolve!: (r: SyncResult) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<SyncResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.queued = {
        branches: request.branches === 'all' ? 'all' : new Set(request.branches),
        promise,
        resolve,
        reject,
      };
    } else if (this.queued.branches !== 'all') {
      if (request.branches === 'all') this.queued.branches = 'all';
      else for (const b of request.branches) this.queued.branches.add(b);
    }
    return this.queued.promise;
  }

  private start(request: SyncRequest): Promise<SyncResult> {
    const run = this.run(request);
    this.inFlight = run.catch(() => undefined).finally(() => {
      this.inFlight = null;
      this.drain();
    });
    return run;
  }

  private drain(): void {
    const next = this.queued;
    if (!next) return;
    this.queued = null;
    const request: SyncRequest = {
      branches: next.branches === 'all' ? 'all' : [...next.branches],
    };
    this.start(request).then(next.resolve, next.reject);
  }

  private async run(request: SyncRequest): Promise<SyncResult> {
    const known = this.workspaces.knownWorkspaces();
    const byBranch = new Map(known.map((w) => [w.branch, w.id]));

    const targets: Array<{ branch: string; id: string | null }> =
      request.branches === 'all'
        ? known.map((w) => ({ branch: w.branch, id: w.id }))
        : request.branches.map((branch) => ({ branch, id: byBranch.get(branch) ?? null }));

    const results: BranchSyncOutcome[] = [];
    for (const { branch, id } of targets) {
      if (id === null) {
        results.push({ branch, outcome: 'not-cloned' });
        continue;
      }
      results.push(await this.workflow.syncWorkspaceFromRemote(id));
    }

    // The host may have deleted a branch (an ADO PR completed with "delete
    // source branch"); the existing sweep closes the Hexis request that
    // pointed at it. Best-effort — it fails safe by closing nothing.
    let closedDeletedBranch = 0;
    try {
      closedDeletedBranch = await this.workflow.closeChangeRequestsWithDeletedBranches();
    } catch (err) {
      console.warn('[sync] deleted-branch sweep failed:', err instanceof Error ? err.message : err);
    }

    const clean = results.every(
      (r) => r.outcome === 'updated' || r.outcome === 'up-to-date' || r.outcome === 'not-cloned',
    );
    return {
      status: clean ? 'synced' : 'partial',
      results,
      changeRequests: { closedDeletedBranch },
    };
  }
}
