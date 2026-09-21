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
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import {
  ChangeRequestConflictsError,
  PullRebaseConflictError,
  WorkflowDomainError,
} from '../../../shared/domain-errors.js';

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
  pullError?: Error;
}) {
  const git = {
    pull: opts.pullError
      ? vi.fn().mockRejectedValue(opts.pullError)
      : vi.fn().mockResolvedValue({ treeChanged: false }),
    mergeFromOrigin: vi.fn().mockResolvedValue(opts.merge ?? { kind: 'clean', alreadyUpToDate: false }),
    push: vi.fn().mockResolvedValue(undefined),
  };
  const refreshed = detail({ behind: false });
  const getPrDetail = vi
    .fn()
    .mockResolvedValueOnce(opts.first === undefined ? detail() : opts.first)
    .mockResolvedValue(refreshed);
  const prs = { getPrDetail, invalidateDetailCache: vi.fn() };
  const pendingCommits = { enqueueIfAbsent: vi.fn().mockResolvedValue(true) };
  const svc = new WorkflowService(
    {} as unknown as Database,
    git as unknown as GitService,
    prs as unknown as PullRequestService,
    {} as unknown as IReviewWorkflowService,
    {} as unknown as WorkspaceService,
    {} as unknown as IAccessControl,
    {} as unknown as FileLockService,
    pendingCommits as unknown as PendingCommitsService,
    'knowledge-base',
    openChangeGate(),
  );
  return { svc, git, prs, pendingCommits, refreshed };
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
    const h = harness({ first: detail({ state: 'merged' }) });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toThrow(/only open requests/);
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
  });

  it('refuses a request that does not exist — nothing is merged', async () => {
    const h = harness({ first: null });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toThrow(/not found/);
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
    expect(h.git.push).not.toHaveBeenCalled();
  });

  it('an already up-to-date merge pushes nothing but still returns the refreshed detail', async () => {
    const h = harness({ merge: { kind: 'clean', alreadyUpToDate: true } });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toBe(h.refreshed);
    expect(h.git.push).not.toHaveBeenCalled();
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
  });

  it('a rebase conflict refreshing the checkout queues recovery for the saves, then refuses', async () => {
    const conflict = new PullRebaseConflictError('alice/deal', ['Sales/Deal.md'], 'rebase stopped');
    const h = harness({ pullError: conflict });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toBe(conflict);
    expect(h.pendingCommits.enqueueIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, branch: 'alice/deal', path: 'Sales/Deal.md', authorEmail: USER.email }),
    );
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
  });

  it('a failed refresh of the proposal checkout stops the Update before any merge', async () => {
    const h = harness({ pullError: new Error('fetch failed') });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toThrow(/fetch failed/);
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
    expect(h.git.push).not.toHaveBeenCalled();
  });
});
