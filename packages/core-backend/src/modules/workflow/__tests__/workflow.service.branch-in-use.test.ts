import { describe, it, expect, vi, beforeEach } from 'vitest';
import { drizzle } from 'drizzle-orm/pg-proxy';
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
 * could not be read (the detail read resolves the target first), declined, or
 * deleted, and the boot sweep looked at sources only, so it survived every
 * restart.
 *
 * These tests run the REAL drizzle query against seeded rows (via the pg-proxy
 * driver, which hands the generated SQL and its parameters to a callback)
 * rather than a stub that answers by call order. That is deliberate: a mock
 * blind to the `where` clause returns the same row whether the guard asks
 * about one branch end or both, so it would pass just as happily against the
 * source-only code this fixes — it could not detect the regression it exists
 * for. Here, reverting `openChangeRequestOn` to a source-only lookup makes the
 * seeded `Y -> X` row stop matching, and these tests fail.
 */

interface CrRow {
  number: number;
  source_branch: string;
  target_branch: string;
  state: string;
}

/**
 * A `change_requests` table that answers the query it is actually given.
 *
 * The driver receives real SQL and real parameters, so the predicate is read
 * back off the statement: every `"column" = $n` becomes a (column, value)
 * pair. One value bound to SEVERAL columns is the either-end test and ORs
 * across them (`source_branch = $1 or target_branch = $1`); distinct values
 * AND together (`… and state = $2`). Non-`select` statements report one
 * affected row, which is the guarded update in the sweep succeeding.
 */
function fakeDb(rows: CrRow[]) {
  const statements: string[] = [];
  const db = drizzle(async (sql: string, params: unknown[]) => {
    statements.push(sql);
    if (!/^\s*select/i.test(sql)) return { rows: [['row-id']] };

    const projection = (/^\s*select\s+(.+?)\s+from\s/is.exec(sql)?.[1] ?? '')
      .split(',')
      .map((item) => item.trim().replace(/.*"(\w+)"$/, '$1'));

    const byValue = new Map<unknown, string[]>();
    for (const m of sql.matchAll(/"(\w+)"\s*=\s*\$(\d+)/g)) {
      const value = params[Number(m[2]) - 1];
      byValue.set(value, [...(byValue.get(value) ?? []), m[1]!]);
    }

    const matched = rows.filter((row) =>
      [...byValue].every(([value, columns]) =>
        columns.some((c) => row[c as keyof CrRow] === value),
      ),
    );
    return { rows: matched.map((row) => projection.map((c) => row[c as keyof CrRow])) };
  });
  return { db: db as unknown as Database, statements };
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

/** The merged request, and a second one still proposing INTO its source. */
const MERGED_23: CrRow = {
  number: 23,
  source_branch: 'juan/rfi',
  target_branch: 'target-company-state',
  state: 'merged',
};
const OPEN_24_INTO_RFI: CrRow = {
  number: 24,
  source_branch: 'juan/rfi-mock',
  target_branch: 'juan/rfi',
  state: 'open',
};

function retire(svc: WorkflowService, number: number, base: string) {
  return (
    svc as unknown as {
      retireMergedSourceBranch(n: number, base: string, u: unknown): Promise<void>;
    }
  ).retireMergedSourceBranch(number, base, USER);
}

beforeEach(() => {
  configureBranchModel({
    defaultBranch: 'target-company-state',
    protectedBranches: ['current-company-state', 'target-company-state'],
  });
});

describe('post-merge branch retirement', () => {
  it('keeps a branch another open request proposes INTO', async () => {
    const deleted: string[] = [];
    const { db, statements } = fakeDb([MERGED_23, OPEN_24_INTO_RFI]);
    const svc = makeService(db, {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    });

    await retire(svc, 23, 'target-company-state');

    expect(deleted).toEqual([]);
    // The guard must ask about both ends — a statement naming only
    // `source_branch` is the regression.
    expect(statements.some((q) => /target_branch/.test(q))).toBe(true);
  });

  it('still retires a branch nothing open needs', async () => {
    const deleted: string[] = [];
    // #24 is gone; only the merged request remains, so nothing needs the branch.
    const { db } = fakeDb([MERGED_23]);
    const svc = makeService(db, {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    });

    await retire(svc, 23, 'target-company-state');

    expect(deleted).toEqual(['juan/rfi']);
  });

  it('keeps a branch another open request proposes FROM', async () => {
    const deleted: string[] = [];
    const { db } = fakeDb([
      MERGED_23,
      { number: 25, source_branch: 'juan/rfi', target_branch: 'other', state: 'open' },
    ]);
    const svc = makeService(db, {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    });

    await retire(svc, 23, 'target-company-state');

    expect(deleted).toEqual([]);
  });
});

describe('deleteBranch', () => {
  it('refuses a branch an open request proposes INTO', async () => {
    const { db } = fakeDb([OPEN_24_INTO_RFI]);
    const svc = makeService(db, { deleteBranch: vi.fn() });

    await expect(svc.deleteBranch('ws', 'juan/rfi', USER)).rejects.toThrow(
      /open change request \(#24\)/,
    );
  });

  it('allows a branch no open request names', async () => {
    const deleted: string[] = [];
    const { db } = fakeDb([OPEN_24_INTO_RFI]);
    const svc = makeService(db, {
      deleteBranch: vi.fn(async (_ws: string, name: string) => void deleted.push(name)),
    });

    await svc.deleteBranch('ws', 'juan/unrelated', USER);

    expect(deleted).toEqual(['juan/unrelated']);
  });
});

describe('closeChangeRequestsWithDeletedBranches', () => {
  it('closes a request whose TARGET branch is gone', async () => {
    const { db } = fakeDb([OPEN_24_INTO_RFI]);
    const svc = makeService(db, {
      // #24's source lives on; its target `juan/rfi` is gone.
      listBranches: vi.fn(async () => [
        { name: 'target-company-state' },
        { name: 'juan/rfi-mock' },
      ]),
    } as unknown as Partial<GitService>);

    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(1);
  });

  it('leaves a request whose branches both exist', async () => {
    const { db } = fakeDb([
      { ...OPEN_24_INTO_RFI, target_branch: 'target-company-state' },
    ]);
    const svc = makeService(db, {
      listBranches: vi.fn(async () => [
        { name: 'target-company-state' },
        { name: 'juan/rfi-mock' },
      ]),
    } as unknown as Partial<GitService>);

    await expect(svc.closeChangeRequestsWithDeletedBranches()).resolves.toBe(0);
  });
});
