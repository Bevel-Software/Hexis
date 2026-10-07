import { describe, it, expect, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
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
import type { WorkflowEventBus } from '../event-bus.js';
import {
  ChangeRequestConflictsError,
  PullRebaseConflictError,
  PushNeedsAgentResolutionError,
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
    needsUpdate: true,
    viewerCanUpdate: true,
    headSha: HEAD,
    mergeBaseSha: 'c'.repeat(40),
    // The pre-flight read asks for no patches, but it still names the files —
    // which is what the fallback for a failed diff answers with.
    files: [{ path: 'Sales/Deal.md' }],
    ...overrides,
  } as unknown as PullRequestDetail;
}

function harness(opts: {
  first?: PullRequestDetail | null;
  /** The published head of the proposal branch as resolved just before the merge. */
  publishedHead?: string;
  /**
   * The published head AFTER the merge. Defaults to the merge commit; set it
   * equal to the pre-merge head to describe a merge that moved nothing.
   */
  headAfterMerge?: string;
  resolveError?: Error;
  merge?: { kind: 'clean'; alreadyUpToDate: boolean } | { kind: 'conflicts'; paths: string[] };
  pullError?: Error;
  /** What the merge commit moved, as git would report it between the heads. */
  changedPaths?: string[];
  changedPathsError?: Error;
  /** How many approval rows the carry-forward wrote. */
  carried?: number;
  /** Does the clone hold commits origin has not seen? */
  unpushed?: boolean;
  unpushedError?: Error;
  /** Each push answers the next of these in turn: an Error rejects, undefined lands. */
  pushes?: Array<Error | undefined>;
}) {
  // Two resolves per update: once after the pull (where the branch IS), once
  // after the merge (where it ended up). One mock that answers in order, so a
  // test can describe a head that moved without stubbing call indices.
  const preMergeHead = opts.publishedHead ?? HEAD;
  const postMergeHead = opts.headAfterMerge ?? MERGED_HEAD;
  const resolvePrShas = opts.resolveError
    ? vi.fn().mockRejectedValue(opts.resolveError)
    : vi
        .fn()
        .mockResolvedValueOnce({ baseSha: 'b'.repeat(40), headSha: preMergeHead })
        .mockResolvedValue({ baseSha: 'b'.repeat(40), headSha: postMergeHead });
  const git = {
    pull: opts.pullError
      ? vi.fn().mockRejectedValue(opts.pullError)
      : vi.fn().mockResolvedValue({ treeChanged: false }),
    mergeFromOrigin: vi.fn().mockResolvedValue(opts.merge ?? { kind: 'clean', alreadyUpToDate: false }),
    push: (opts.pushes ?? []).reduce(
      (fn, outcome) => (outcome ? fn.mockRejectedValueOnce(outcome) : fn.mockResolvedValueOnce(undefined)),
      vi.fn().mockResolvedValue(undefined),
    ),
    hasUnpushedCommits: opts.unpushedError
      ? vi.fn().mockRejectedValue(opts.unpushedError)
      : vi.fn().mockResolvedValue(opts.unpushed ?? true),
    pathsChangedBetween: opts.changedPathsError
      ? vi.fn().mockRejectedValue(opts.changedPathsError)
      : vi.fn().mockResolvedValue(opts.changedPaths ?? []),
    resolvePrShas,
  };
  const refreshed = detail({ behind: false, needsUpdate: false, headSha: postMergeHead });
  // Exactly two reads per update: the pre-flight (authority, branch names)
  // and the one that goes back. A third would be the cost this ticket removed.
  const getPrDetail = vi
    .fn()
    .mockResolvedValueOnce(opts.first === undefined ? detail() : opts.first)
    .mockResolvedValue(refreshed);
  const prs = { getPrDetail, invalidateDetailCache: vi.fn() };
  const pendingCommits = { enqueueIfAbsent: vi.fn().mockResolvedValue(true) };
  const reviewWorkflow = {
    carryApprovalsForward: vi.fn().mockResolvedValue(opts.carried ?? 0),
  };
  const emit = vi.fn();
  const svc = new WorkflowService(
    {} as unknown as Database,
    git as unknown as GitService,
    prs as unknown as PullRequestService,
    reviewWorkflow as unknown as IReviewWorkflowService,
    {} as unknown as WorkspaceService,
    {} as unknown as IAccessControl,
    {} as unknown as FileLockService,
    pendingCommits as unknown as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
    { emit } as unknown as WorkflowEventBus,
  );
  return { svc, git, prs, pendingCommits, reviewWorkflow, refreshed, emit };
}

describe('WorkflowService.updateFromTarget', () => {
  it('merges the target into the proposal, pushes, and returns the refreshed detail', async () => {
    const h = harness({ changedPaths: ['Sales/Deal.md'] });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toEqual({
      ...h.refreshed,
      updatedPaths: ['Sales/Deal.md'],
    });

    // The permission read is computed for THIS caller — and asks for no
    // patches: all it decides is authority, state and the two branch names.
    expect(h.prs.getPrDetail).toHaveBeenNthCalledWith(1, 7, {
      fresh: true,
      workspaceId: WS,
      viewerEmail: USER.email,
      patches: false,
    });
    expect(h.git.mergeFromOrigin).toHaveBeenCalledWith(WS, 'alice/deal', 'current-company-state', USER);
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
    expect(h.refreshed.behind).toBe(false);
  });

  it('costs ONE detail read after the merge', async () => {
    // The whole point of the ticket on the server side. Two reads total: the
    // pre-flight that decides authority, and the one that goes back. The
    // carry-forward runs BEFORE that second read rather than correcting it
    // with a third.
    const h = harness({ changedPaths: ['Sales/Deal.md'], carried: 2 });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.prs.getPrDetail).toHaveBeenCalledTimes(2);
    const carriedAt = h.reviewWorkflow.carryApprovalsForward.mock.invocationCallOrder[0];
    const lastReadAt = h.prs.getPrDetail.mock.invocationCallOrder[1];
    expect(carriedAt).toBeLessThan(lastReadAt);
  });

  it('replays the pull with --rebase-merges, so an unpushed merge stays a merge', async () => {
    // A plain rebase flattens a merge commit origin has not seen into
    // cherry-picks of the target's commits, which drops the target as a
    // parent — and the request never contains the target's head however many
    // times the update runs.
    const h = harness({});
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.pull).toHaveBeenCalledWith(WS, { preserveMerges: true });
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

  it('an already up-to-date merge with nothing unpushed pushes nothing', async () => {
    const h = harness({
      merge: { kind: 'clean', alreadyUpToDate: true },
      unpushed: false,
      headAfterMerge: HEAD,
    });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toEqual({
      ...h.refreshed,
      updatedPaths: [],
    });
    expect(h.git.push).not.toHaveBeenCalled();
    expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
  });

  it('retries a push that failed last time, even though this merge has nothing to do', async () => {
    // The loop this ticket closes. An earlier update merged the target in and
    // its push failed, so the merge is sitting in the clone. This update's
    // merge is therefore ALREADY up to date — and the old gate, which pushed
    // only when the merge authored a commit, skipped the push and left the
    // request behind on the remote for the next open to find.
    const h = harness({
      merge: { kind: 'clean', alreadyUpToDate: true },
      unpushed: true,
      publishedHead: HEAD,
      headAfterMerge: MERGED_HEAD,
      changedPaths: ['Sales/Deal.md'],
    });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.hasUnpushedCommits).toHaveBeenCalledWith(WS);
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
  });

  it('falls back to "did this merge author a commit" when git cannot say what is unpushed', async () => {
    // Never "push anyway": a push on a clone with nothing to push is a wasted
    // round trip on every update.
    const clean = harness({ unpushedError: new Error('git exploded') });
    await clean.svc.updateFromTarget(WS, USER, 7);
    expect(clean.git.push).toHaveBeenCalledWith(WS, USER);

    const nothingToDo = harness({
      unpushedError: new Error('git exploded'),
      merge: { kind: 'clean', alreadyUpToDate: true },
      headAfterMerge: HEAD,
    });
    await nothingToDo.svc.updateFromTarget(WS, USER, 7);
    expect(nothingToDo.git.push).not.toHaveBeenCalled();
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
  it('carries them onto the new head, before the one detail read that goes back', async () => {
    const h = harness({ changedPaths: ['Sales/Deal.md'], carried: 2 });

    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toEqual({
      ...h.refreshed,
      updatedPaths: ['Sales/Deal.md'],
    });

    // What moved is git's answer between the two heads — never a guess, and
    // never the request's own three-dot diff against the target.
    expect(h.git.pathsChangedBetween).toHaveBeenCalledWith(WS, HEAD, MERGED_HEAD);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledWith(
      7,
      HEAD,
      MERGED_HEAD,
      ['Sales/Deal.md'],
    );
  });

  it('answers the same list as updatedPaths — carried and re-read cannot disagree', async () => {
    // A file whose approval was carried (so: untouched by the merge) that the
    // dialog then re-read would be the dialog discarding content the server
    // just called unchanged.
    const h = harness({ changedPaths: ['Sales/Deal.md', 'Sales/Terms.md'], carried: 1 });
    const result = await h.svc.updateFromTarget(WS, USER, 7);
    expect(result.updatedPaths).toEqual(['Sales/Deal.md', 'Sales/Terms.md']);
    expect(h.reviewWorkflow.carryApprovalsForward).toHaveBeenCalledWith(
      7,
      HEAD,
      MERGED_HEAD,
      result.updatedPaths,
    );
  });

  it('touches nothing when the head did not move', async () => {
    const h = harness({
      merge: { kind: 'clean', alreadyUpToDate: true },
      unpushed: false,
      headAfterMerge: HEAD,
    });
    const result = await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
    expect(result.updatedPaths).toEqual([]);
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
    // Both resolves fail, so the head reads as unmoved from the detail's own
    // — there is no pair of shas to diff, and the update still lands.
    const h = harness({ resolveError: new Error('no such ref'), carried: 1 });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('carries nothing when there is no head to compare at all', async () => {
    // The resolve failed AND the detail carries no head either — a degraded
    // read, not a merge outcome. There is no pair of shas to diff, so the
    // bookkeeping is skipped rather than attempted with an empty one (which
    // `carryApprovalsForward` would refuse outright).
    const h = harness({
      first: detail({ headSha: '' }),
      resolveError: new Error('no such ref'),
      carried: 1,
    });
    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toEqual({
      ...h.refreshed,
      updatedPaths: [],
    });
    expect(h.git.push).toHaveBeenCalledWith(WS, USER);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('still returns the up-to-date request when the bookkeeping itself fails', async () => {
    // A request that IS up to date is worth more than the carry-forward: the
    // approvals simply go stale, exactly as they did before this existed.
    const h = harness({ changedPathsError: new Error('git exploded') });
    const result = await h.svc.updateFromTarget(WS, USER, 7);
    expect(result).toMatchObject({ number: 7, behind: false });
    expect(h.reviewWorkflow.carryApprovalsForward).not.toHaveBeenCalled();
    // Which files moved is unknown, so every file the request had is named:
    // slow beats a dialog that goes on presenting pre-merge text as current.
    expect(result.updatedPaths).toEqual(['Sales/Deal.md']);
  });

  describe('when the repository host refuses the push', () => {
    const REFUSED = new Error('git push failed: remote: Internal Server Error');

    it('keeps the merge applied locally and answers 409 with the saved-locally sentence and the banner', async () => {
      const h = harness({ changedPaths: ['Sales/Deal.md'], pushes: [REFUSED] });
      const err = await h.svc.updateFromTarget(WS, USER, 7).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PushNeedsAgentResolutionError);
      expect((err as PushNeedsAgentResolutionError).status).toBe(409);
      expect((err as Error).message).toContain('Saved locally on "alice/deal"');
      expect(JSON.stringify((err as PushNeedsAgentResolutionError).payload)).not.toContain('Internal Server Error');
      // One attempt: a refusal is not a divergence, so nothing is retried.
      expect(h.git.push).toHaveBeenCalledTimes(1);
      // The merge ran and stays in the clone — the next push carries it.
      expect(h.git.mergeFromOrigin).toHaveBeenCalledTimes(1);
      expect(h.emit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'git-sync-failed', workspaceId: 'alice/deal', branch: 'alice/deal' }),
      );
    });

    it('the next update pushes what is still unpushed, and the banner clears', async () => {
      const h = harness({
        changedPaths: ['Sales/Deal.md'],
        unpushed: true,
        pushes: [REFUSED, undefined],
      });
      await expect(h.svc.updateFromTarget(WS, USER, 7)).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
      await h.svc.updateFromTarget(WS, USER, 7);
      const kinds = h.emit.mock.calls.map((c) => (c[0] as { kind: string }).kind).filter((k) => k.startsWith('git-sync-'));
      expect(kinds).toEqual(['git-sync-failed', 'git-sync-recovered']);
    });

    it('a non-fast-forward recovers with a merge-preserving pull, so the merge stays a merge', async () => {
      const h = harness({
        changedPaths: ['Sales/Deal.md'],
        pushes: [new Error('! [rejected] alice/deal -> alice/deal (non-fast-forward)'), undefined],
      });
      await h.svc.updateFromTarget(WS, USER, 7);
      expect(h.git.push).toHaveBeenCalledTimes(2);
      expect(h.git.pull).toHaveBeenLastCalledWith(WS, { preserveMerges: true });
    });
  });
});
