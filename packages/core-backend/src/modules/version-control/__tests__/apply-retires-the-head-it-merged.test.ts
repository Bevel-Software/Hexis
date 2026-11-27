import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import type { IAccessControl } from '../../access/index.js';
import type { Database } from '../../database/index.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { VersionControlEventBus } from '../event-bus.js';
import type { FileLockService } from '../file-lock.service.js';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlService } from '../version-control.service.js';

/**
 * Applying a change request deletes its branch only at the head it merged.
 *
 * The merge lands one commit of the branch, the head its gate judged. A push
 * that reaches the branch after the merge read it is on no other branch, so
 * deleting the branch by name would delete that commit with it. The deletion
 * is therefore handed the merged head (`expectTip`), and the shared repository
 * refuses it when the branch is anywhere else (pinned on real repositories in
 * `version-control.service.delete-branch.test.ts`, "a commit pushed after it
 * is refused at deletion").
 */

const TRUNK = 'trunk';
const DRAFT = 'someone/add-a-note';
const USER: AuthUser = { id: 'u1', email: 'someone@x.com', name: 'Someone' };
const GATED_HEAD = 'head-the-gate-judged';
const kb = testKbContext({ branchModel: { defaultBranch: TRUNK, protectedBranches: [TRUNK] } });

/**
 * The request's branch to the one lookup that asks for it alone, and no rows
 * to every other read: no other open request names the branch.
 */
function makeDb(): Database {
  const rows = (data: unknown[]) => {
    const p = Promise.resolve(data) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  return {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const keys = Object.keys(fields ?? {});
          return rows(keys.length === 1 && keys[0] === 'sourceBranch' ? [{ sourceBranch: DRAFT }] : []);
        },
      }),
    }),
  } as unknown as Database;
}

function makeSvc(deleteBranch: GitService['deleteBranch']) {
  const git = {
    fetch: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue({ treeChanged: false }),
    // No roles.yaml on either side, so Apply restores nothing and the head it
    // merges is the head it was handed.
    readFileAtRef: vi.fn().mockResolvedValue(null),
    deleteBranch,
  } as unknown as GitService;
  const prs = {
    getPr: vi.fn().mockResolvedValue({ branch: DRAFT, base: TRUNK }),
    invalidateDetailCache: vi.fn(),
  } as unknown as PullRequestService;
  const changeRequestReview = {
    mergePr: vi.fn().mockResolvedValue({ prNumber: 1, sha: 'merged-sha', mergedAt: 't' }),
  } as unknown as IChangeRequestReviewService;
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async (branch: string) => ({ id: `ws:${branch}` })),
    getWorkspacePath: vi.fn(async (id: string) => `/tmp/${id}`),
    ensureRemotesFetched: vi.fn().mockResolvedValue(undefined),
    hasBootstrappedWorkspace: vi.fn().mockResolvedValue(false),
  } as unknown as WorkspaceService;
  const svc = new VersionControlService(
    makeDb(),
    git,
    prs,
    changeRequestReview,
    workspaceService,
    { invalidate: vi.fn() } as unknown as IAccessControl,
    { acquire: vi.fn(), release: vi.fn() } as unknown as FileLockService,
    {} as unknown as PendingCommitsService,
    kb,
    openChangeGate(),
    { emit: vi.fn() } as unknown as VersionControlEventBus,
  );
  const apply = () => svc.mergeChangeRequest(1, USER, GATED_HEAD, [], 'open', 'T', TRUNK, 'w1');
  return { apply };
}

describe('applying a change request retires its branch at the head it merged', () => {
  it('deletes the branch only while it is still at the merged head', async () => {
    const deleteBranch = vi.fn<GitService['deleteBranch']>().mockResolvedValue({ lastCommit: GATED_HEAD });
    const { apply } = makeSvc(deleteBranch);

    await apply();

    expect(deleteBranch).toHaveBeenCalledTimes(1);
    expect(deleteBranch).toHaveBeenCalledWith(
      `ws:${TRUNK}`,
      DRAFT,
      USER,
      expect.objectContaining({ systemCleanup: true, expectTip: GATED_HEAD }),
    );
  });

  it('still answers that the request was applied when the branch had moved and its deletion is refused', async () => {
    const deleteBranch = vi
      .fn<GitService['deleteBranch']>()
      .mockRejectedValue(new Error('stale info: the branch is not at the expected commit'));
    const { apply } = makeSvc(deleteBranch);

    await expect(apply()).resolves.toMatchObject({ kind: 'merged' });
    expect(deleteBranch).toHaveBeenCalledTimes(1);
  });
});
