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
 * Bringing a change request up to date: merge the target into the proposal
 * branch on the server and push it. Only the author or someone who may apply
 * the request may run it, and a conflicting merge must leave nothing behind —
 * no commit, no push — and report the conflict so the dialog can hand the
 * author's agent the prompt.
 *
 * The dialog now runs this by ITSELF on open, which makes the approval
 * bookkeeping load-bearing: a merge nobody asked for must not void approvals
 * over files it never touched. That holds for every caller of the route — the
 * dialog, an agent, an older client — because it lives here and not in any
 * of them.
 */

const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
/** The proposal's head before the update, and the merge commit after it. */
const HEAD = 'a'.repeat(40);
const MERGED_HEAD = 'd'.repeat(40);
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
    headSha: HEAD,
    mergeBaseSha: 'c'.repeat(40),
    ...overrides,
  } as PullRequestDetail;
}

function harness(opts: {
  first?: PullRequestDetail | null;
  /** The published head of the proposal branch as resolved just before the merge. */
  publishedHead?: string;
  resolveError?: Error;
  merge?: { kind: 'clean'; alreadyUpToDate: boolean } | { kind: 'conflicts'; paths: string[] };
  pullError?: Error;
  /** What the merge commit moved, as git would report it between the heads. */
  changedPaths?: string[];
  changedPathsError?: Error;
  /** How many approval rows the carry-forward wrote. */
  carried?: number;
  /** The detail the extra read after a carry-forward answers with. */
  withApprovals?: PullRequestDetail;
}) {
  const git = {
    pull: opts.pullError
      ? vi.fn().mockRejectedValue(opts.pullError)
      : vi.fn().mockResolvedValue({ treeChanged: false }),
    mergeFromOrigin: vi.fn().mockResolvedValue(opts.merge ?? { kind: 'clean', alreadyUpToDate: false }),
    push: vi.fn().mockResolvedValue(undefined),
    pathsChangedBetween: opts.changedPathsError
      ? vi.fn().mockRejectedValue(opts.changedPathsError)
      : vi.fn().mockResolvedValue(opts.changedPaths ?? []),
    resolvePrShas: opts.resolveError
      ? vi.fn().mockRejectedValue(opts.resolveError)
      : vi.fn().mockResolvedValue({
          baseSha: 'b'.repeat(40),
          headSha: opts.publishedHead ?? HEAD,
        }),
  };
  const refreshed = detail({ behind: false, headSha: MERGED_HEAD });
  const getPrDetail = vi
    .fn()
    .mockResolvedValueOnce(opts.first === undefined ? detail() : opts.first)
    .mockResolvedValueOnce(refreshed)
    .mockResolvedValue(opts.withApprovals ?? refreshed);
  const prs = { getPrDetail, invalidateDetailCache: vi.fn() };
  const pendingCommits = { enqueueIfAbsent: vi.fn().mockResolvedValue(true) };
  const reviewWorkflow = {
    carryApprovalsForward: vi.fn().mockResolvedValue(opts.carried ?? 0),
  };
  const svc = new WorkflowService(
    {} as unknown as Database,
    git as unknown as GitService,
    prs as unknown as PullRequestService,
    reviewWorkflow as unknown as IReviewWorkflowService,
    {} as unknown as WorkspaceService,
    {} as unknown as IAccessControl,
    {} as unknown as FileLockService,
    pendingCommits as unknown as PendingCommitsService,
    'knowledge-base',
    openChangeGate(),
  );
  return { svc, git, prs, pendingCommits, reviewWorkflow, refreshed };
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

describe('WorkflowService.updateFromTarget: the approvals the merge did not touch', () => {
  it('carries them onto the new head, and re-reads the detail so the gate sees them', async () => {
    const withApprovals = detail({ behind: false, headSha: MERGED_HEAD, mergeableInBevel: true });
    const h = harness({
      changedPaths: ['Sales/Deal.md'],
      carried: 2,
      withApprovals,
    });

    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toBe(withApprovals);

    // What moved is git's answer between the two heads — never a guess, and
    // never the request's own three-dot diff against the target.
    expect(h.git.pathsChangedBetween).toHaveBeenCalledWith(WS, HEAD, MERGED_HEAD);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledWith(
      7,
      HEAD,
      MERGED_HEAD,
      ['Sales/Deal.md'],
    );
    // The first refreshed detail was assembled before the rows existed, so it
    // is not the one that goes back.
    expect(h.prs.getPrDetail).toHaveBeenCalledTimes(3);
  });

  it('does not re-read the detail when nothing carried', async () => {
    const h = harness({ changedPaths: ['Sales/Deal.md'], carried: 0 });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toBe(h.refreshed);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledTimes(1);
    expect(h.prs.getPrDetail).toHaveBeenCalledTimes(2);
  });

  it('touches nothing when the merge had nothing to do', async () => {
    const h = harness({ merge: { kind: 'clean', alreadyUpToDate: true } });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('touches nothing when the merge conflicted — the rows describe a head that still stands', async () => {
    const h = harness({ merge: { kind: 'conflicts', paths: ['Sales/Deal.md'] } });
    await h.svc.updateFromTarget(WS, USER, 7).catch(() => undefined);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('carries them from the head the branch is actually ON, not the one the detail read', async () => {
    // Somebody pushed to the proposal branch between the detail read and the
    // pull — an agent, or the author from another client. The approvals a
    // reviewer made in that window are pinned to THAT head; carrying forward
    // from the sha the stale detail reported would find no rows and void every
    // approval the merge never touched.
    const PUSHED = 'e'.repeat(40);
    const h = harness({ publishedHead: PUSHED, changedPaths: ['Sales/Deal.md'], carried: 1 });

    await h.svc.updateFromTarget(WS, USER, 7);

    // Resolved after the pull and before the merge, from the branch itself.
    expect(h.git.resolvePrShas).toHaveBeenCalledWith(WS, 'current-company-state', 'alice/deal');
    expect(h.git.pathsChangedBetween).toHaveBeenCalledWith(WS, PUSHED, MERGED_HEAD);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledWith(7, PUSHED, MERGED_HEAD, [
      'Sales/Deal.md',
    ]);
  });

  it('falls back to the head the detail reported when that head cannot be resolved', async () => {
    // Bookkeeping never costs the update: an unresolvable ref leaves the
    // carry-forward working off the detail's head, exactly as it did before.
    const h = harness({ resolveError: new Error('no such ref'), carried: 1 });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledWith(7, HEAD, MERGED_HEAD, []);
  });

  it('carries nothing when the branch was already at the head the merge produced', async () => {
    // The published head resolved before the merge IS the head afterwards:
    // there is no pair of heads to compare, so there is nothing to re-pin.
    const h = harness({ publishedHead: MERGED_HEAD });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('still returns the up-to-date request when the bookkeeping itself fails', async () => {
    // A request that IS up to date is worth more than the carry-forward: the
    // approvals simply go stale, exactly as they did before this existed.
    const h = harness({ changedPathsError: new Error('git exploded') });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toBe(h.refreshed);
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });
});
