import { describe, it, expect, vi } from 'vitest';
import type { AuthUser, PullRequestDetail } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';
import { ChangeRequestConflictsError, WorkflowDomainError } from '../../../shared/domain-errors.js';

/**
 * The request dialog's Update: merge the target into the proposal branch on
 * the server and push it. Only the author or someone who may apply the
 * request may run it, and a conflicting merge must leave nothing behind —
 * no commit, no push — and report the conflict so the dialog can hand the
 * author's agent the prompt.
 */

const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
const WS = encodeURIComponent('alice/deal');

function detail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    number: 7,
    title: 'Deal terms',
    state: 'open',
    branch: 'alice/deal',
    base: 'current-company-state',
    behind: true,
    viewerCanUpdate: true,
    mergeBaseSha: 'c'.repeat(40),
    ...overrides,
  } as PullRequestDetail;
}

function harness(opts: {
  first?: PullRequestDetail | null;
  merge?: { kind: 'clean'; alreadyUpToDate: boolean } | { kind: 'conflicts'; paths: string[] };
}) {
  const git = {
    pull: vi.fn().mockResolvedValue({ treeChanged: false }),
    mergeFromOrigin: vi.fn().mockResolvedValue(opts.merge ?? { kind: 'clean', alreadyUpToDate: false }),
    push: vi.fn().mockResolvedValue(undefined),
  };
  const refreshed = detail({ behind: false });
  const getPrDetail = vi
    .fn()
    .mockResolvedValueOnce(opts.first === undefined ? detail() : opts.first)
    .mockResolvedValue(refreshed);
  const prs = { getPrDetail, invalidateDetailCache: vi.fn() };
  const svc = new WorkflowService(
    {} as unknown as Database,
    git as unknown as GitService,
    prs as unknown as PullRequestService,
    {} as unknown as IReviewWorkflowService,
    {} as unknown as WorkspaceService,
    {} as unknown as IAccessControl,
    {} as unknown as FileLockService,
    {} as unknown as PendingCommitsService,
    'knowledge-base',
  );
  return { svc, git, prs, refreshed };
}

describe('WorkflowService.updateFromTarget', () => {
  it('merges the target into the proposal, pushes, and returns the refreshed detail', async () => {
    const h = harness({});
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toBe(h.refreshed);

    // The permission read is computed for THIS caller.
    expect(h.prs.getPrDetail).toHaveBeenNthCalledWith(1, 7, {
      fresh: true,
      workspaceId: WS,
      viewerEmail: USER.email,
    });
    expect(h.git.mergeFromOrigin).toHaveBeenCalledWith(WS, 'alice/deal', 'current-company-state', USER);
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(h.refreshed.behind).toBe(false);
  });

  it('refuses a viewer who is neither the author nor able to apply — nothing is merged', async () => {
    const h = harness({ first: detail({ viewerCanUpdate: false }) });
    const err = await h.svc.updateFromTarget(WS, USER, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowDomainError);
    expect((err as WorkflowDomainError).status).toBe(403);
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
    expect(h.git.push).not.toHaveBeenCalled();
  });

  it('a conflicting merge reports the conflicted paths and pushes nothing', async () => {
    const h = harness({ merge: { kind: 'conflicts', paths: ['Sales/Deal.md'] } });
    const err = await h.svc.updateFromTarget(WS, USER, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChangeRequestConflictsError);
    expect((err as ChangeRequestConflictsError).status).toBe(409);
    expect((err as ChangeRequestConflictsError).conflictedPaths).toEqual(['Sales/Deal.md']);
    expect(h.git.push).not.toHaveBeenCalled();
  });

  it('refuses a request that is not open', async () => {
    const h = harness({ first: detail({ state: 'merged', viewerCanUpdate: false }) });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toThrow(/only open requests/);
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
  });
});
