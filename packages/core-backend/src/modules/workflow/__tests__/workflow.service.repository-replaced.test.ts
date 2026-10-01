import { describe, it, expect, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';

/**
 * The CLOSE half of the admin's choice when the knowledge-base repository is
 * replaced: the requests point at branches that are not in the new
 * repository, so they are closed — with a reason, releasing the locks held on
 * those branches and taking any commit still queued for them off the worker,
 * and without deleting a single row.
 */

interface ClosedRow {
  number: number;
  sourceBranch: string;
}

/**
 * DB stub shaped like the real close: ONE `update … where state = 'open'
 * returning` per pass, answering with the rows that pass actually closed.
 *
 * `passes` is therefore what the statement RETURNS, pass by pass — which is
 * how a request already closed by a merge or a withdrawal is expressed (it is
 * simply not in the returned set) and how a request opened BETWEEN passes is
 * expressed (it turns up in a later one). A pass past the end answers nothing,
 * which is what stops the loop.
 */
function makeDb(passes: ClosedRow[][], sets: Record<string, unknown>[], openCount: number) {
  let pass = 0;
  const db = {
    // The count is a SQL aggregate: one row, one integer.
    select: () => ({ from: () => ({ where: async () => [{ open: openCount }] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => ({ returning: async () => passes[pass++] ?? [] }) };
      },
    }),
    // Nothing here may ever delete a change request.
    delete: () => {
      throw new Error('a change request must never be deleted');
    },
  };
  return db as unknown as Database;
}

function makeService(passes: ClosedRow[][], openCount = passes.flat().length) {
  const sets: Record<string, unknown>[] = [];
  const unlocked: string[] = [];
  const dequeued: string[] = [];
  const invalidated: number[] = [];
  const emitted: unknown[] = [];
  const fileLocks = {
    releaseAllOnBranch: vi.fn(async (branch: string) => {
      unlocked.push(branch);
      return 2;
    }),
  } as unknown as FileLockService;
  const pendingCommits = {
    markNeedsAttentionOnBranch: vi.fn(async (branch: string) => {
      dequeued.push(branch);
      return 1;
    }),
  } as unknown as PendingCommitsService;
  const prs = {
    invalidateDetailCache: vi.fn((n: number) => invalidated.push(n)),
  } as unknown as PullRequestService;
  const svc = new WorkflowService(
    makeDb(passes, sets, openCount),
    {} as GitService,
    prs,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    fileLocks,
    pendingCommits,
    testKbContext(),
    openChangeGate(),
  );
  (svc as unknown as { events?: { emit(e: unknown): void } }).events = {
    emit: (e: unknown) => emitted.push(e),
  };
  return { svc, sets, unlocked, dequeued, invalidated, emitted, fileLocks, pendingCommits };
}

describe('closeOpenChangeRequestsAsRepositoryReplaced', () => {
  it('closes every open request with the reason, and deletes nothing', async () => {
    const { svc, sets, invalidated, emitted } = makeService([
      [
        { number: 7, sourceBranch: 'alice/draft' },
        { number: 9, sourceBranch: 'bob/draft' },
      ],
    ]);

    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(2);

    // ONE statement closed both: a read-then-write loop would have missed any
    // request opened while it ran.
    expect(sets).toHaveLength(2); // the closing pass, then the pass that found nothing
    expect(sets[0]?.state).toBe('closed');
    // The reason outlives the admin who chose it — that is the whole point
    // of a column rather than a log line.
    expect(sets[0]?.closedReason).toBe('repository-replaced');
    expect(sets[0]?.closedAt).toBeInstanceOf(Date);
    expect(invalidated).toEqual([7, 9]);
    expect(emitted).toEqual([
      { kind: 'change-request-rejected', number: 7 },
      { kind: 'change-request-rejected', number: 9 },
    ]);
  });

  it('closes a request opened while it was closing the others', async () => {
    // The deployment is still live — the address has not been saved yet — so
    // `POST /change-requests` is still being served. The first pass closed two;
    // #11 arrived after it and is closed by the next one.
    const { svc, invalidated } = makeService([
      [
        { number: 7, sourceBranch: 'alice/draft' },
        { number: 9, sourceBranch: 'bob/draft' },
      ],
      [{ number: 11, sourceBranch: 'carol/draft' }],
    ]);

    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(3);
    expect(invalidated).toEqual([7, 9, 11]);
  });

  it('gives up after a bounded number of passes rather than holding the save open', async () => {
    // A client opening requests in a loop must not be able to keep the save
    // from ever returning. What survives the last pass was opened after the
    // repository was replaced, and the deleted-branch sweep owns it.
    const endless = Array.from({ length: 50 }, (_, i) => [
      { number: i + 1, sourceBranch: `writer-${i}/draft` },
    ]);
    const { svc } = makeService(endless, 50);
    const closed = await svc.closeOpenChangeRequestsAsRepositoryReplaced();
    expect(closed).toBeGreaterThan(0);
    expect(closed).toBeLessThan(50);
  });

  it('skips a request a merge or a withdrawal closed first', async () => {
    // The guard is the statement's own `where state = 'open'`: #9 was closed by
    // somebody else between the count and this call, so it is not in the
    // returned set — and nothing is done on its behalf.
    const { svc, unlocked, dequeued, invalidated, emitted } = makeService(
      [[{ number: 7, sourceBranch: 'alice/draft' }]],
      2,
    );

    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(1);

    expect(unlocked).toEqual(['alice/draft']);
    expect(dequeued).toEqual(['alice/draft']);
    expect(invalidated).toEqual([7]);
    expect(emitted).toEqual([{ kind: 'change-request-rejected', number: 7 }]);
  });

  it('releases the file locks held on the branches it closes', async () => {
    const { svc, unlocked } = makeService([
      [
        { number: 7, sourceBranch: 'alice/draft' },
        { number: 9, sourceBranch: 'bob/draft' },
      ],
    ]);

    await svc.closeOpenChangeRequestsAsRepositoryReplaced();

    // Nobody can publish those bytes or release the lock by finishing: the
    // branch belongs to a repository this deployment no longer has.
    expect(unlocked).toEqual(['alice/draft', 'bob/draft']);
  });

  it('takes the commits already queued for those branches off the worker', async () => {
    const { svc, dequeued, pendingCommits } = makeService([
      [{ number: 7, sourceBranch: 'alice/draft' }],
    ]);

    await svc.closeOpenChangeRequestsAsRepositoryReplaced();

    // A release ENQUEUES the bytes and only then drops its lock, so dropping
    // the locks can leave rows waiting. Left pending, the worker would commit
    // them onto a same-named branch of a different repository after the
    // re-clone.
    expect(dequeued).toEqual(['alice/draft']);
    expect(vi.mocked(pendingCommits.markNeedsAttentionOnBranch).mock.calls[0]?.[1]).toMatch(
      /repository was replaced/,
    );
  });

  it('still closes the requests when a lock release fails', async () => {
    const { svc, fileLocks } = makeService([[{ number: 7, sourceBranch: 'alice/draft' }]]);
    vi.mocked(fileLocks.releaseAllOnBranch).mockRejectedValueOnce(new Error('lock table is down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The close is the decision the admin made; a lock expires on its own
      // within the minute, so it is not worth half-closing the set over.
      await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still closes the requests when the queued commits cannot be set aside', async () => {
    const { svc, pendingCommits, unlocked } = makeService([
      [{ number: 7, sourceBranch: 'alice/draft' }],
    ]);
    vi.mocked(pendingCommits.markNeedsAttentionOnBranch).mockRejectedValueOnce(
      new Error('pending_commits is down'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(1);
      expect(unlocked).toEqual(['alice/draft']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('closes nothing, and asks nothing of the lock table, when no request is open', async () => {
    const { svc, unlocked, dequeued, emitted } = makeService([]);
    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(0);
    expect(unlocked).toEqual([]);
    expect(dequeued).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe('countOpenChangeRequests', () => {
  it('answers how many are open, so the confirmation can say what it is about', async () => {
    const { svc } = makeService([], 2);
    // A SQL aggregate: the question is an integer, and materializing one row
    // per open request to answer it would scale with the wrong thing.
    await expect(svc.countOpenChangeRequests()).resolves.toBe(2);
  });

  it('answers zero when the aggregate comes back empty', async () => {
    const { svc } = makeService([], 0);
    await expect(svc.countOpenChangeRequests()).resolves.toBe(0);
  });
});
