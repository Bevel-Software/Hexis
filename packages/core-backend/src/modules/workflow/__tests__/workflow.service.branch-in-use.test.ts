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
 * A branch is load-bearing for a change request at EITHER end.
 *
 * The regression: merging `X -> main` retired X while a second open request
 * `Y -> X` still proposed INTO it. Every guard asked only "is X anybody's
 * SOURCE?", so X was deleted and `Y -> X` became permanently unusable — it
 * could not be read (the detail read resolves the target first), declined,
 * or deleted, and the boot sweep looked at sources only, so it survived
 * every restart.
 */

/** Answers each `select()` in call order; drizzle both awaits and `.limit()`s. */
function makeDb(answers: unknown[][]) {
  let i = 0;
  const result = () => {
    const rows = Promise.resolve(answers[Math.min(i++, answers.length - 1)] ?? []);
    return { limit: () => rows, then: rows.then.bind(rows) };
  };
  return { select: () => ({ from: () => ({ where: result }) }) } as unknown as Database;
}

function makeService(db: Database, git: Partial<GitService>) {
  return new WorkflowService(
    db,
    git as GitService,
    { invalidateDetailCache: vi.fn() } as unknown as PullRequestService,
    {} as IReviewWorkflowService,
    {
      getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-target' })),
      ensureRemotesFetched: vi.fn(async () => undefined),
      hasBootstrappedWorkspace: vi.fn(async () => false),
    } as unknown as WorkspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    {} as PendingCommitsService,
    'knowledge-base',
  );
}

const USER = { email: 'juan@example.com', name: 'Juan', id: 'u1' };

beforeEach(() => {
  configureBranchModel({
    defaultBranch: 'target-company-state',
    protectedBranches: ['current-company-state', 'target-company-state'],
  });
});

describe('post-merge branch retirement', () => {
  it('keeps a branch another open request proposes INTO', async () => {
    const deleted: string[] = [];
    const git = {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    };
    // 1: the merged request's own source. 2: open requests naming it — #24,
    // which uses it as its TARGET.
    const svc = makeService(makeDb([[{ sourceBranch: 'juan/rfi' }], [{ number: 24 }]]), git);

    await (
      svc as unknown as {
        retireMergedSourceBranch(n: number, base: string, u: unknown): Promise<void>;
      }
    ).retireMergedSourceBranch(23, 'target-company-state', USER);

    expect(deleted).toEqual([]);
  });

  it('still retires a branch nothing open needs', async () => {
    const deleted: string[] = [];
    const git = {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    };
    const svc = makeService(makeDb([[{ sourceBranch: 'juan/rfi' }], []]), git);

    await (
      svc as unknown as {
        retireMergedSourceBranch(n: number, base: string, u: unknown): Promise<void>;
      }
    ).retireMergedSourceBranch(23, 'target-company-state', USER);

    expect(deleted).toEqual(['juan/rfi']);
  });
});

describe('deleteBranch', () => {
  it('refuses a branch an open request proposes INTO', async () => {
    const svc = makeService(makeDb([[{ number: 24 }]]), { deleteBranch: vi.fn() });
    await expect(svc.deleteBranch('ws', 'juan/rfi', USER)).rejects.toThrow(
      /open change request \(#24\)/,
    );
  });
});

describe('closeChangeRequestsWithDeletedBranches', () => {
  /** Sweep DB stub: one open row, and a recording guarded update. */
  function sweepDb(rows: unknown[], closed: number[]) {
    return {
      select: () => ({ from: () => ({ where: async () => rows }) }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => {
              closed.push(1);
              return [{ id: 'r' }];
            },
          }),
        }),
      }),
    } as unknown as Database;
  }

  it('closes a request whose TARGET branch is gone', async () => {
    const closed: number[] = [];
    const svc = makeService(
      sweepDb([{ number: 24, sourceBranch: 'juan/rfi-mock', targetBranch: 'juan/rfi' }], closed),
      {
        listBranches: vi.fn(async () => [
          { name: 'target-company-state' },
          { name: 'juan/rfi-mock' }, // its source lives on; the target is gone
        ]),
      },
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(1);
    expect(closed).toHaveLength(1);
  });

  it('leaves a request whose branches both exist', async () => {
    const closed: number[] = [];
    const svc = makeService(
      sweepDb(
        [{ number: 24, sourceBranch: 'juan/rfi-mock', targetBranch: 'target-company-state' }],
        closed,
      ),
      {
        listBranches: vi.fn(async () => [
          { name: 'target-company-state' },
          { name: 'juan/rfi-mock' },
        ]),
      },
    );
    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
    expect(closed).toEqual([]);
  });
});
