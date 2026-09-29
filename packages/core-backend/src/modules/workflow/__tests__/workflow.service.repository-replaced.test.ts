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
 * those branches, and without deleting a single row.
 */

interface OpenRow {
  number: number;
  sourceBranch: string;
}

/** DB stub that records every `set()` a guarded update was given. */
function makeDb(open: OpenRow[], sets: Record<string, unknown>[]) {
  const db = {
    select: () => ({ from: () => ({ where: async () => open }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return { where: () => ({ returning: async () => [{ id: 'row' }] }) };
      },
    }),
    // Nothing here may ever delete a change request.
    delete: () => {
      throw new Error('a change request must never be deleted');
    },
  };
  return db as unknown as Database;
}

function makeService(open: OpenRow[]) {
  const sets: Record<string, unknown>[] = [];
  const unlocked: string[] = [];
  const invalidated: number[] = [];
  const emitted: unknown[] = [];
  const fileLocks = {
    releaseAllOnBranch: vi.fn(async (branch: string) => {
      unlocked.push(branch);
      return 2;
    }),
  } as unknown as FileLockService;
  const prs = {
    invalidateDetailCache: vi.fn((n: number) => invalidated.push(n)),
  } as unknown as PullRequestService;
  const svc = new WorkflowService(
    makeDb(open, sets),
    {} as GitService,
    prs,
    {} as IReviewWorkflowService,
    {} as WorkspaceService,
    {} as IAccessControl,
    fileLocks,
    {} as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
  );
  (svc as unknown as { events?: { emit(e: unknown): void } }).events = {
    emit: (e: unknown) => emitted.push(e),
  };
  return { svc, sets, unlocked, invalidated, emitted, fileLocks };
}

describe('closeOpenChangeRequestsAsRepositoryReplaced', () => {
  it('closes every open request with the reason, and deletes nothing', async () => {
    const { svc, sets, invalidated, emitted } = makeService([
      { number: 7, sourceBranch: 'alice/draft' },
      { number: 9, sourceBranch: 'bob/draft' },
    ]);

    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(2);

    expect(sets).toHaveLength(2);
    for (const values of sets) {
      expect(values.state).toBe('closed');
      // The reason outlives the admin who chose it — that is the whole point
      // of a column rather than a log line.
      expect(values.closedReason).toBe('repository-replaced');
      expect(values.closedAt).toBeInstanceOf(Date);
    }
    expect(invalidated).toEqual([7, 9]);
    expect(emitted).toEqual([
      { kind: 'change-request-rejected', number: 7 },
      { kind: 'change-request-rejected', number: 9 },
    ]);
  });

  it('releases the file locks held on the branches it closes', async () => {
    const { svc, unlocked } = makeService([
      { number: 7, sourceBranch: 'alice/draft' },
      { number: 9, sourceBranch: 'bob/draft' },
    ]);

    await svc.closeOpenChangeRequestsAsRepositoryReplaced();

    // Nobody can publish those bytes or release the lock by finishing: the
    // branch belongs to a repository this deployment no longer has.
    expect(unlocked).toEqual(['alice/draft', 'bob/draft']);
  });

  it('still closes the requests when a lock release fails', async () => {
    const { svc, fileLocks } = makeService([{ number: 7, sourceBranch: 'alice/draft' }]);
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

  it('closes nothing, and asks nothing of the lock table, when no request is open', async () => {
    const { svc, unlocked, emitted } = makeService([]);
    await expect(svc.closeOpenChangeRequestsAsRepositoryReplaced()).resolves.toBe(0);
    expect(unlocked).toEqual([]);
    expect(emitted).toEqual([]);
  });
});

describe('countOpenChangeRequests', () => {
  it('answers how many are open, so the confirmation can say what it is about', async () => {
    const { svc } = makeService([
      { number: 7, sourceBranch: 'alice/draft' },
      { number: 9, sourceBranch: 'bob/draft' },
    ]);
    await expect(svc.countOpenChangeRequests()).resolves.toBe(2);
  });
});
