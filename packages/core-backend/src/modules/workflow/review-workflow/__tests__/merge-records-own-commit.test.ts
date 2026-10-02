import { describe, it, expect, vi } from 'vitest';

import { ReviewWorkflowService } from '../review-workflow.service.js';
import { changeRequests } from '../../../database/schema.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../../git/git.service.js';
import type { AppliedMergeResult, AuthUser, FileApprovalState } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../../access/access-control.interface.js';

/**
 * What `mergePr` records as a change request's `merged_sha`, which is the only
 * thing an applied request's files can later be read from.
 *
 * Two shas come back from the merge and they are not interchangeable: `sha` is
 * the state the target is left at, `mergeCommit` is the commit this request
 * owns. Recording the first publishes another request's files under this
 * request's number (cubic P1 on #347); dropping the second when a retry finds
 * nothing left to merge makes an already-merged request permanently fileless
 * (cubic P2 on #347). The row must take `mergeCommit`, exactly.
 */

const USER: AuthUser = { id: 'u-alice', email: 'alice@bevel.software', name: 'Alice' };
const BASE = 'current-company-state';
const HEAD_SHA = 'head-sha-1';

const CR_ROW = {
  id: 'cr-1',
  number: 12,
  sourceBranch: 'alice/add',
  targetBranch: BASE,
  title: 'Add a note',
  body: '',
  authorEmail: 'alice@bevel.software',
  authorName: 'Alice',
  state: 'open',
};

/**
 * One approved file, which is all the gate needs to let the merge through: an
 * empty approval set is itself a hard block ("no file changes to approve"), so
 * the "nothing to merge" cases below are about git finding the change already on
 * the target, never about a request with no files.
 */
const APPROVED: FileApprovalState = {
  path: 'Knowledge/Ops/note.md',
  eligibleApprovers: { roles: ['Ops'], users: [] },
  approvedBy: [
    {
      name: 'Olga',
      email: 'olga@bevel.software',
      approvedAt: '2026-10-02T10:00:00Z',
      isStale: false,
      isSelfApproval: false,
    },
  ],
  eligibilityResolved: true,
  isApproved: true,
  inMergeGate: true,
  viewerCanApprove: false,
};

/** Every `update(...).set(...)` the merge performs, with the table it targeted. */
type Captured = { table: unknown; values: Record<string, unknown> };

function makeDb(captured: Captured[]): Database {
  const thenable = (data: unknown) => {
    const p = Promise.resolve(data) as Promise<unknown> & { limit: () => Promise<unknown> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => thenable(table === changeRequests ? [CR_ROW] : []) }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'merge-log-1' }] }) }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        captured.push({ table, values });
        return {
          where: () => {
            const t = thenable(undefined) as unknown as Promise<unknown> & {
              returning: () => Promise<unknown>;
            };
            // Non-empty, so the CAS counts as won and the merge finalizes.
            t.returning = () => Promise.resolve([{ id: CR_ROW.id }]);
            return t;
          },
        };
      },
    }),
  } as unknown as Database;
}

function makeService(mergeResult: AppliedMergeResult) {
  const captured: Captured[] = [];
  // Typed by its signature rather than its body, so the recorded call keeps the
  // arguments the assertion below reads out of it.
  const mergeChangeRequest = vi.fn<(...args: unknown[]) => Promise<AppliedMergeResult>>(
    async () => mergeResult,
  );
  const workspace = {
    ensureRemotesFetched: vi.fn(async () => undefined),
    getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
  } as unknown as WorkspaceService;
  const svc = new ReviewWorkflowService(
    makeDb(captured),
    {} as unknown as IAccessControl,
    workspace,
    { mergeChangeRequest } as unknown as GitService,
  );
  const merge = () =>
    svc.mergePr(CR_ROW.number, USER, HEAD_SHA, [APPROVED], 'open', CR_ROW.title, BASE, 'ws-1');
  /** The values written to the change request row (not the merge log). */
  const crUpdate = () => captured.find((c) => c.table === changeRequests)?.values;
  return { merge, crUpdate, mergeChangeRequest };
}

describe('mergePr — which commit the row records', () => {
  it('records the merge commit this request owns, not the state the target is left at', async () => {
    const { merge, crUpdate } = makeService({
      kind: 'merged',
      sha: 'target-tip-which-is-another-requests-merge',
      mergeCommit: 'this-requests-own-merge',
    });

    const result = await merge();

    expect(crUpdate()).toMatchObject({ state: 'merged', mergedSha: 'this-requests-own-merge' });
    // The caller still hears the state the target is at, which is what "merged"
    // means for the request even when it is not a commit of its own.
    expect(result.sha).toBe('target-tip-which-is-another-requests-merge');
  });

  it('records nothing when the request owns no merge commit', async () => {
    // The genuinely empty request: the target already contained its change, and
    // no attempt of its own ever wrote a commit. It has no file list to lose, and
    // the target tip it is merged at belongs to somebody else.
    const { merge, crUpdate } = makeService({
      kind: 'merged',
      sha: 'target-tip-which-is-another-requests-merge',
      mergeCommit: null,
    });

    await merge();

    expect(crUpdate()).toMatchObject({ state: 'merged', mergedSha: null });
  });

  it('names the request to the merge, so a retry can recognise its own commit', async () => {
    // Without the number, a merge that finds nothing to merge cannot tell an
    // empty request from one whose merge commit a previous attempt pushed before
    // the row update failed — and would record null for both.
    const { merge, mergeChangeRequest } = makeService({
      kind: 'merged',
      sha: 'tip',
      mergeCommit: 'own',
    });

    await merge();

    expect(mergeChangeRequest).toHaveBeenCalledTimes(1);
    const opts = mergeChangeRequest.mock.calls[0][5] as { appliedChangeNumber?: number };
    expect(opts.appliedChangeNumber).toBe(CR_ROW.number);
  });
});
