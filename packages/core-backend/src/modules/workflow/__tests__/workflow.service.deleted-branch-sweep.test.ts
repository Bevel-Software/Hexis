import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureBranchModel } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';

/**
 * `closeChangeRequestsWithDeletedBranches` — the boot sweep that retires
 * change requests whose branch is gone.
 *
 * Everything here is about NOT closing the wrong thing. A change request is
 * somebody's proposal and the row is the only surviving evidence of it once
 * the branch has been deleted, so the interesting cases are the ones where
 * the sweep must keep its hands off.
 */

interface OpenRow {
  number: number;
  sourceBranch: string;
}

/**
 * DB stub: `select().from().where()` resolves the open rows, and
 * `update().set().where().returning()` records each close and reports one
 * affected row (the guarded update succeeding).
 */
function makeDb(open: OpenRow[], closedOut: number[]) {
  const db = {
    select: () => ({ from: () => ({ where: async () => open }) }),
    update: () => ({
      set: () => ({
        where: (cond: unknown) => ({
          returning: async () => {
            // The number is not recoverable from the drizzle condition object,
            // so the caller records it via the `onClose` hook below instead.
            void cond;
            return [{ id: 'row' }];
          },
        }),
      }),
    }),
  };
  void closedOut;
  return db as unknown as Database;
}

function makeService(open: OpenRow[], listBranches: () => Promise<{ name: string }[]>) {
  const invalidated: number[] = [];
  const emitted: unknown[] = [];
  const git = { listBranches: vi.fn(listBranches) } as unknown as GitService;
  const prs = {
    invalidateDetailCache: vi.fn((n: number) => invalidated.push(n)),
  } as unknown as PullRequestService;
  const svc = new WorkflowService(
    makeDb(open, []),
    git,
    prs,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    {} as PendingCommitsService,
    'knowledge-base',
  );
  (svc as unknown as { events?: { emit(e: unknown): void } }).events = {
    emit: (e: unknown) => emitted.push(e),
  };
  return { svc, git, invalidated, emitted };
}

beforeEach(() => {
  configureBranchModel({
    defaultBranch: 'target-company-state',
    protectedBranches: ['current-company-state', 'target-company-state'],
  });
});

describe('closeChangeRequestsWithDeletedBranches', () => {
  it('closes a request whose source branch is gone', async () => {
    const { svc, invalidated, emitted } = makeService(
      [{ number: 7, sourceBranch: 'demo2' }],
      async () => [{ name: 'target-company-state' }, { name: 'alice/live-work' }],
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(1);
    // The open lists cache per request; a closed one has to drop out of them.
    expect(invalidated).toEqual([7]);
    expect(emitted).toEqual([{ kind: 'change-request-rejected', number: 7 }]);
  });

  it('leaves a request whose branch still exists', async () => {
    const { svc, invalidated } = makeService(
      [{ number: 7, sourceBranch: 'alice/live-work' }],
      async () => [{ name: 'target-company-state' }, { name: 'alice/live-work' }],
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
    expect(invalidated).toEqual([]);
  });

  /**
   * The reason the verdict comes from `listBranches({ freshFetch: true })`
   * rather than from the `unknown branch` error the open-list already throws:
   * that error means "missing from THIS workspace's refs", which a clone that
   * never fetched somebody else's branch reports identically. Only origin can
   * answer the question being asked.
   */
  it('asks for a FRESH fetch, so origin decides rather than a stale clone', async () => {
    const { svc, git } = makeService([{ number: 7, sourceBranch: 'x' }], async () => [
      { name: 'x' },
    ]);
    await svc.closeChangeRequestsWithDeletedBranches();
    expect(git.listBranches).toHaveBeenCalledWith('target-company-state', { freshFetch: true });
  });

  /**
   * "Could not reach origin" and "the branch was deleted" are indistinguishable
   * from in here, and only one of them is a reason to close somebody's
   * proposal. So a failure closes NOTHING — the sweep runs again next boot.
   */
  it('closes nothing when the branch list cannot be fetched', async () => {
    const { svc, invalidated } = makeService(
      [{ number: 7, sourceBranch: 'demo2' }],
      async () => {
        throw new Error('origin unreachable');
      },
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
    expect(invalidated).toEqual([]);
  });

  /**
   * An empty branch list means the clone is broken, not that every branch in
   * the repository was deleted at once — and acting on it would close EVERY
   * open request in one pass. The most destructive possible reading of an
   * ambiguous signal, so it is refused explicitly.
   */
  it('closes nothing when the branch list comes back empty', async () => {
    const { svc, invalidated } = makeService(
      [
        { number: 7, sourceBranch: 'demo2' },
        { number: 8, sourceBranch: 'other' },
      ],
      async () => [],
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
    expect(invalidated).toEqual([]);
  });

  it('does not fetch at all when nothing is open', async () => {
    const { svc, git } = makeService([], async () => [{ name: 'target-company-state' }]);
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
    expect(git.listBranches).not.toHaveBeenCalled();
  });

  it('closes several in one pass and leaves the live ones', async () => {
    const { svc, invalidated } = makeService(
      [
        { number: 1, sourceBranch: 'juan/onboarding-import-mr92q9vx4a9e' },
        { number: 3, sourceBranch: 'juan-legal-test-cr' },
        { number: 7, sourceBranch: 'demo2' },
        { number: 9, sourceBranch: 'alice/live-work' },
      ],
      async () => [{ name: 'target-company-state' }, { name: 'alice/live-work' }],
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(3);
    expect(invalidated).toEqual([1, 3, 7]);
  });
});
