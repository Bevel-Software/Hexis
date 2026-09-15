import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureBranchModel } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IReviewWorkflowService } from '../review-workflow/review-workflow.interface.js';
import type { WorkspaceService, IdleWorkspace } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/connection.js';
import { WorkflowService } from '../workflow.service.js';

/**
 * `retireIdleWorkspaces` — the sweep that frees the workspaces volume of
 * clones nobody opens. The git layer decides whether a clone may go; this
 * suite is about what the sweep does around that decision: which clones it
 * never asks about, what it passes the git layer as the queue question and
 * the removal, and that one bad clone does not end the sweep.
 */

const DAY = 86_400_000;

function makeService(idle: IdleWorkspace[], verdicts: Record<string, 'retired' | 'dirty' | 'unpushed' | 'queued' | Error>) {
  const removed: string[] = [];
  const asked: string[] = [];
  const retireClone = vi.fn(
    async (id: string, opts: { queued: () => Promise<boolean>; remove: () => Promise<void> }) => {
      asked.push(id);
      const verdict = verdicts[id];
      if (verdict instanceof Error) throw verdict;
      if (verdict === 'retired') {
        await opts.queued();
        await opts.remove();
      }
      return verdict ?? 'retired';
    },
  );
  const git = { retireClone } as unknown as GitService;
  const workspaceService = {
    idleWorkspaces: vi.fn(async () => idle),
    deleteWorkspace: vi.fn(async (id: string) => {
      removed.push(id);
    }),
  } as unknown as WorkspaceService;
  const pendingCommits = {
    hasAnyForWorkspace: vi.fn(async () => false),
  } as unknown as PendingCommitsService;
  const svc = new WorkflowService(
    {} as Database,
    git,
    {} as PullRequestService,
    {} as IReviewWorkflowService,
    workspaceService,
    {} as IAccessControl,
    {} as FileLockService,
    pendingCommits,
    'knowledge-base',
  );
  return { svc, asked, removed, workspaceService, pendingCommits };
}

beforeEach(() => {
  configureBranchModel({
    defaultBranch: 'target-company-state',
    protectedBranches: ['current-company-state', 'target-company-state'],
  });
});

describe('retireIdleWorkspaces', () => {
  it('retires the clones the git layer clears, through the workspace service', async () => {
    const { svc, removed, pendingCommits } = makeService(
      [
        { id: 'ali%2Fold', branch: 'ali/old', idleMs: 40 * DAY },
        { id: 'juan%2Fstale', branch: 'juan/stale', idleMs: 35 * DAY },
      ],
      { 'ali%2Fold': 'retired', 'juan%2Fstale': 'unpushed' },
    );

    const outcome = await svc.retireIdleWorkspaces(30 * DAY);
    expect(outcome).toEqual({ retired: ['ali/old'], kept: [{ branch: 'juan/stale', reason: 'unpushed' }] });
    expect(removed).toEqual(['ali%2Fold']);
    // The queue question the git layer asked was the commit queue's, for this clone.
    expect(pendingCommits.hasAnyForWorkspace).toHaveBeenCalledWith('ali%2Fold');
  });

  it('never asks about a protected branch, however idle its clone', async () => {
    const { svc, asked, removed } = makeService(
      [
        { id: 'target-company-state', branch: 'target-company-state', idleMs: 400 * DAY },
        { id: 'current-company-state', branch: 'current-company-state', idleMs: 400 * DAY },
      ],
      {},
    );

    expect(await svc.retireIdleWorkspaces(30 * DAY)).toEqual({ retired: [], kept: [] });
    expect(asked).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('keeps a clone it cannot judge, and goes on to the next', async () => {
    const { svc, removed } = makeService(
      [
        { id: 'a', branch: 'a', idleMs: 40 * DAY },
        { id: 'b', branch: 'b', idleMs: 40 * DAY },
      ],
      { a: new Error('git: index file corrupt'), b: 'retired' },
    );

    const outcome = await svc.retireIdleWorkspaces(30 * DAY);
    expect(outcome.kept).toEqual([{ branch: 'a', reason: 'error' }]);
    expect(outcome.retired).toEqual(['b']);
    expect(removed).toEqual(['b']);
  });

  it('does nothing when retention is switched off', async () => {
    const { svc, workspaceService } = makeService([{ id: 'a', branch: 'a', idleMs: 400 * DAY }], { a: 'retired' });
    expect(await svc.retireIdleWorkspaces(0)).toEqual({ retired: [], kept: [] });
    expect(workspaceService.idleWorkspaces).not.toHaveBeenCalled();
  });

  it('passes the retention through as the idle threshold', async () => {
    const { svc, workspaceService } = makeService([], {});
    await svc.retireIdleWorkspaces(7 * DAY);
    expect(workspaceService.idleWorkspaces).toHaveBeenCalledWith(7 * DAY);
  });
});
