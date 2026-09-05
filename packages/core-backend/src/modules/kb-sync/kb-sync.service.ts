import type { BranchSyncOutcome } from '@bevel-software/platform-shared';
import { sanitizeError } from '../workflow/sanitize-error.js';
import type {
  IKbSyncService,
  LastSync,
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
    by: Set<string>;
    promise: Promise<SyncResult>;
    resolve: (r: SyncResult) => void;
    reject: (e: unknown) => void;
  } | null = null;
  private last: LastSync | null = null;

  constructor(
    private readonly workflow: SyncWorkflowPort,
    private readonly workspaces: SyncWorkspacePort,
    private readonly now: () => number = () => Date.now(),
  ) {}

  lastSync(): LastSync | null {
    return this.last;
  }

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
        by: new Set(request.by ? [request.by] : []),
        promise,
        resolve,
        reject,
      };
    } else {
      if (this.queued.branches !== 'all') {
        if (request.branches === 'all') this.queued.branches = 'all';
        else for (const b of request.branches) this.queued.branches.add(b);
      }
      if (request.by) this.queued.by.add(request.by);
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
      by: next.by.size > 0 ? [...next.by].join(', ') : undefined,
    };
    this.start(request).then(next.resolve, next.reject);
  }

  private async run(request: SyncRequest): Promise<SyncResult> {
    const known = await this.workspaces.listClonedWorkspaces();
    const byBranch = new Map(known.map((w) => [w.branch, w.id]));

    const targets: Array<{ branch: string; id: string | null }> =
      request.branches === 'all'
        ? known.map((w) => ({ branch: w.branch, id: w.id }))
        : request.branches.map((branch) => ({ branch, id: byBranch.get(branch) ?? null }));

    const unreadable = new Map(known.filter((w) => w.unreadable).map((w) => [w.branch, w.unreadable!]));

    const results: BranchSyncOutcome[] = [];
    for (const { branch, id } of targets) {
      if (id === null) {
        results.push({ branch, outcome: 'not-cloned' });
        continue;
      }
      const cannotRead = unreadable.get(branch);
      if (cannotRead) {
        results.push({ branch, outcome: 'error', error: cannotRead });
        continue;
      }
      let outcome: BranchSyncOutcome;
      try {
        outcome = await this.workflow.syncWorkspaceFromRemote(id);
      } catch (err) {
        // The workflow step promises outcomes, not throws — but one broken
        // clone must never take the other branches, the sweep, or every
        // coalesced caller down with it, so the promise is enforced here too.
        const message = sanitizeError(err);
        console.error(`[sync] unexpected failure syncing "${branch}": ${message}`);
        outcome = { branch, outcome: 'error', error: message };
      }
      results.push(outcome);
      if (outcome.outcome === 'remote-gone') {
        // The host deleted the branch. Left in place, the stale clone would
        // fail its fetch on every following full sync — and a webhook host
        // disables a subscription that keeps failing. The workflow retires it
        // under the branch-lifecycle lock, after asking origin again, so a
        // branch recreated since the pull keeps its clone. Best-effort.
        try {
          const removed = await this.workflow.retireRemoteGoneClone(id);
          if (removed) console.log(`[sync] removed the clone of "${branch}" — deleted on the host`);
          else console.log(`[sync] kept the clone of "${branch}" — it is back on the host, or already gone`);
        } catch (err) {
          console.warn(`[sync] could not remove the clone of "${branch}":`, sanitizeError(err));
        }
      }
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
      (r) =>
        r.outcome === 'updated' ||
        r.outcome === 'up-to-date' ||
        r.outcome === 'not-cloned' ||
        r.outcome === 'remote-gone',
    );
    const result: SyncResult = {
      status: clean ? 'synced' : 'partial',
      results,
      changeRequests: { closedDeletedBranch },
    };
    this.last = {
      at: this.now(),
      by: request.by ?? 'unknown',
      status: result.status,
      results: [...results],
    };
    return result;
  }
}
