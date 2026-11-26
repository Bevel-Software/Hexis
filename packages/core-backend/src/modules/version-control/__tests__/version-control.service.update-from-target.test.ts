import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser, PullRequestDetail } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import type { Database } from '../../database/index.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { VersionControlService } from '../version-control.service.js';
import { openChangeGate } from '../../../__tests__/open-change-gate.js';
import type { VersionControlEventBus } from '../event-bus.js';
import {
  ChangeRequestConflictsError,
  PullRebaseConflictError,
  PushNeedsAgentResolutionError,
  VersionControlDomainError,
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

/**
 * A `change_requests` table for the open-request guard's one read
 * (`source = $1 and target = $2 and state = $3`): it answers the rows that
 * condition holds for, as the table would. Any other read fails the test
 * rather than matching silently.
 */
function requestsDb(rows: Array<{ number: number; sourceBranch: string; targetBranch: string; state: string }>): Database {
  let where: SQL | undefined;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: (condition: SQL) => {
      where = condition;
      return chain;
    },
    limit: async () => {
      const { sql, params } = new PgDialect().sqlToQuery(where!);
      const expected =
        '("change_requests"."source_branch" = $1 and "change_requests"."target_branch" = $2 and "change_requests"."state" = $3)';
      if (sql !== expected) throw new Error(`requestsDb: unsupported read: ${sql}`);
      const [source, target, state] = params;
      return rows
        .filter((r) => r.sourceBranch === source && r.targetBranch === target && r.state === state)
        .map((r) => ({ number: r.number }));
    },
  };
  return chain as unknown as Database;
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
  /** The `change_requests` rows the open-request guard reads (#7 itself guards nothing). */
  requests?: Array<{ number: number; sourceBranch: string; targetBranch: string; state: string }>;
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
  const changeRequestReview = {
    carryApprovalsForward: vi.fn().mockResolvedValue(opts.carried ?? 0),
  };
  const emit = vi.fn();
  const svc = new VersionControlService(
    // The caller's array itself, so a row it adds mid-test is one the next read finds.
    requestsDb(opts.requests ?? []),
    git as unknown as GitService,
    prs as unknown as PullRequestService,
    changeRequestReview as unknown as IChangeRequestReviewService,
    {} as unknown as WorkspaceService,
    {} as unknown as IAccessControl,
    {} as unknown as FileLockService,
    pendingCommits as unknown as PendingCommitsService,
    testKbContext(),
    openChangeGate(),
    { emit } as unknown as VersionControlEventBus,
  );
  return { svc, git, prs, pendingCommits, changeRequestReview, refreshed, emit };
}

describe('the target → source refresh has one door', () => {
  it('only `refreshFromTarget`, which asks the open-request guard, calls `git.mergeFromOrigin`', () => {
    // Opening a request and Update both refresh through it. A new caller of
    // the git primitive would be a refresh the guard never sees.
    const src = readFileSync(new URL('../version-control.service.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/\.mergeFromOrigin\(/g)].map((m) => m.index);
    expect(calls).toHaveLength(1);
    const door = src.indexOf('private async refreshFromTarget(');
    expect(door).toBeGreaterThan(-1);
    expect(calls[0]).toBeGreaterThan(door);
    expect(src.slice(door, calls[0])).toContain('this.openRequestBlockingMerge(targetBranch, sourceBranch)');
    expect(src.slice(door, calls[0])).not.toMatch(/\n {2}(private |async |public )/);
  });
});

describe('VersionControlService.updateFromTarget', () => {
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
    const carriedAt = h.changeRequestReview.carryApprovalsForward.mock.invocationCallOrder[0];
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
    expect(err).toBeInstanceOf(VersionControlDomainError);
    expect((err as VersionControlDomainError).status).toBe(403);
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

  it('refuses while a request from the target into this branch is open: nothing is merged or pushed', async () => {
    // #7 is alice/deal → current-company-state. #9 proposes the other way and
    // is open: merging current-company-state into alice/deal is #9's own
    // merge, and would land its unreviewed commits on its target.
    const h = harness({
      requests: [{ number: 9, sourceBranch: 'current-company-state', targetBranch: 'alice/deal', state: 'open' }],
    });
    const err = (await h.svc.updateFromTarget(WS, USER, 7).catch((e: unknown) => e)) as VersionControlDomainError;
    expect(err.status).toBe(409);
    expect(err.payload).toMatchObject({
      kind: 'open-change-request-blocks-merge',
      sourceBranch: 'current-company-state',
      targetBranch: 'alice/deal',
      number: 9,
    });
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
    expect(h.git.push).not.toHaveBeenCalled();
  });

  it('asks and merges under the branch lifecycle key every open takes, so a reverse request opened meanwhile is seen', async () => {
    const requests: Array<{ number: number; sourceBranch: string; targetBranch: string; state: string }> = [];
    const h = harness({ requests });
    // An open of current-company-state → alice/deal holds alice/deal's key
    // while it runs; its row lands before it lets go.
    const lifecycle = (h.svc as unknown as { branchLifecycle: { run<T>(key: string, fn: () => Promise<T>): Promise<T> } })
      .branchLifecycle;
    let land: () => void = () => {};
    const opening = lifecycle.run('branch:alice/deal', () => new Promise<void>((resolve) => { land = resolve; }));
    const update = h.svc.updateFromTarget(WS, USER, 7).catch((e: unknown) => e);
    await new Promise<void>((r) => setImmediate(r));
    requests.push({ number: 9, sourceBranch: 'current-company-state', targetBranch: 'alice/deal', state: 'open' });
    land();
    await opening;
    expect(((await update) as VersionControlDomainError).payload).toMatchObject({ kind: 'open-change-request-blocks-merge', number: 9 });
    expect(h.git.mergeFromOrigin).not.toHaveBeenCalled();
  });

  it('merges as before when the reverse request is closed, or open requests share only one end', async () => {
    const h = harness({
      requests: [
        { number: 9, sourceBranch: 'current-company-state', targetBranch: 'alice/deal', state: 'closed' },
        { number: 10, sourceBranch: 'current-company-state', targetBranch: 'bob/other', state: 'open' },
        { number: 11, sourceBranch: 'bob/other', targetBranch: 'alice/deal', state: 'open' },
      ],
    });
    await h.svc.updateFromTarget(WS, USER, 7);
    expect(h.git.mergeFromOrigin).toHaveBeenCalledWith(WS, 'alice/deal', 'current-company-state', USER);
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

describe('VersionControlService.updateFromTarget: the approvals the merge did not touch', () => {
  it('carries them onto the new head, before the one detail read that goes back', async () => {
    const h = harness({ changedPaths: ['Sales/Deal.md'], carried: 2 });

    await expect(h.svc.updateFromTarget(WS, USER, 7)).resolves.toEqual({
      ...h.refreshed,
      updatedPaths: ['Sales/Deal.md'],
    });

    // What moved is git's answer between the two heads — never a guess, and
    // never the request's own three-dot diff against the target.
    expect(h.git.pathsChangedBetween).toHaveBeenCalledWith(WS, HEAD, MERGED_HEAD);
    expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledWith(
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
    expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledWith(
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
    expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
    expect(result.updatedPaths).toEqual([]);
  });

  it('touches nothing when the merge conflicted — the rows describe a head that still stands', async () => {
    const h = harness({ merge: { kind: 'conflicts', paths: ['Sales/Deal.md'] } });
    await h.svc.updateFromTarget(WS, USER, 7).catch(() => undefined);
    expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
    expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
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
    expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledWith(7, PUSHED, MERGED_HEAD, [
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
    expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
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
    expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
  });

  it('still returns the up-to-date request when the bookkeeping itself fails', async () => {
    // A request that IS up to date is worth more than the carry-forward: the
    // approvals simply go stale, exactly as they did before this existed.
    const h = harness({ changedPathsError: new Error('git exploded') });
    const result = await h.svc.updateFromTarget(WS, USER, 7);
    expect(result).toMatchObject({ number: 7, behind: false });
    expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
    // Which files moved is unknown, so every file the request had is named:
    // slow beats a dialog that goes on presenting pre-merge text as current.
    expect(result.updatedPaths).toEqual(['Sales/Deal.md']);
  });

  describe('when the carry cannot be done', () => {
    // Never "no file needs approving": a file the update changed does, and the notice cannot tell which.
    // Nor a promise that the next open succeeds: it tries again, and can fail again.
    const NOTICE = /could not be carried over.*The server tries again to carry over.*a file the update changed needs approving again/;

    it('says so in words on the answer, and says nothing when the carry worked', async () => {
      const failed = harness({ changedPathsError: new Error('git exploded') });
      const result = await failed.svc.updateFromTarget(WS, USER, 7);
      expect(result.approvalCarryNotice).toMatch(NOTICE);
      expect(result.approvalCarryNotice).not.toMatch(/no file needs approving/i);

      const worked = harness({ changedPaths: ['Sales/Deal.md'], carried: 1 });
      expect(await worked.svc.updateFromTarget(WS, USER, 7)).not.toHaveProperty('approvalCarryNotice');
    });

    it('says so when the diff worked and the copy itself failed, and the next read retries that copy once', async () => {
      const h = harness({ changedPaths: ['Sales/Terms.md'], carried: 1 });
      h.changeRequestReview.carryApprovalsForward.mockRejectedValueOnce(new Error('approval lock timed out'));
      const result = await h.svc.updateFromTarget(WS, USER, 7);
      expect(result.approvalCarryNotice).toMatch(NOTICE);
      // The copy failed, so no file is known to be safe to keep showing.
      expect(result.updatedPaths).toEqual(['Sales/Deal.md']);

      // The same copy, which now works, and then nothing is owed any more.
      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(2);
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenLastCalledWith(7, HEAD, MERGED_HEAD, ['Sales/Terms.md']);
      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(2);
    });

    it('two updates whose carries fail at the same time are both owed', async () => {
      // Both fail in the same turn of the loop. Each has to find the list the
      // other made, or the later one overwrites it and one move is never
      // replayed.
      const THIRD = 'f'.repeat(40);
      const h = harness({});
      // In step: each update resolves its head before the merge, then after.
      const heads = [HEAD, HEAD, MERGED_HEAD, THIRD];
      h.git.resolvePrShas = vi.fn(async () => ({ baseSha: 'b'.repeat(40), headSha: heads.shift()! }));
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      h.git.pathsChangedBetween.mockImplementation(async () => {
        await held;
        throw new Error('git exploded');
      });
      const both = Promise.all([h.svc.updateFromTarget(WS, USER, 7), h.svc.updateFromTarget(WS, USER, 7)]);
      await vi.waitFor(() => expect(h.git.pathsChangedBetween).toHaveBeenCalledTimes(2));
      release();
      for (const result of await both) expect(result.approvalCarryNotice).toMatch(NOTICE);

      h.git.pathsChangedBetween.mockReset().mockResolvedValue([]);
      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        [HEAD, MERGED_HEAD],
        [HEAD, THIRD],
      ]);
    });

    it('the next read of the request tries the same carry again, and a read after that does not', async () => {
      const h = harness({ changedPaths: ['Sales/Terms.md'], carried: 1 });
      h.git.pathsChangedBetween.mockRejectedValueOnce(new Error('git exploded'));
      await h.svc.updateFromTarget(WS, USER, 7);
      expect(h.changeRequestReview.carryApprovalsForward).not.toHaveBeenCalled();
      h.prs.invalidateDetailCache.mockClear();

      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      // Between the same two heads, with what git now answers.
      expect(h.git.pathsChangedBetween).toHaveBeenLastCalledWith(WS, HEAD, MERGED_HEAD);
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(1);
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledWith(7, HEAD, MERGED_HEAD, ['Sales/Terms.md']);
      // The detail cached before the rows existed is dropped before the read.
      expect(h.prs.invalidateDetailCache).toHaveBeenCalledWith(7);
      expect(h.prs.invalidateDetailCache.mock.invocationCallOrder[0]).toBeLessThan(
        h.prs.getPrDetail.mock.invocationCallOrder.at(-1)!,
      );

      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(1);
    });

    it('a read whose retry fails too still answers, and the read after it tries again', async () => {
      const h = harness({ changedPathsError: new Error('git exploded') });
      await h.svc.updateFromTarget(WS, USER, 7);
      await expect(h.svc.getChangeRequestDetail(7, { workspaceId: WS })).resolves.toBe(h.refreshed);
      h.git.pathsChangedBetween.mockReset().mockResolvedValue([]);
      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledWith(7, HEAD, MERGED_HEAD, []);
    });

    it('a request that never failed a carry costs its reads nothing', async () => {
      const h = harness({ changedPaths: ['Sales/Deal.md'], carried: 1 });
      await h.svc.updateFromTarget(WS, USER, 7);
      h.git.pathsChangedBetween.mockClear();
      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.git.pathsChangedBetween).not.toHaveBeenCalled();
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(1);
    });

    it('replays every move of the head since the one that failed, oldest first', async () => {
      // The carry from HEAD to MERGED_HEAD fails. A second update then moves
      // the head on to THIRD and its own carry works, but the rows it could
      // have copied are still on HEAD. The retry has to walk both moves, or
      // the approvals stop one head short.
      const THIRD = 'f'.repeat(40);
      const h = harness({ changedPaths: [], carried: 0 });
      h.git.pathsChangedBetween.mockRejectedValueOnce(new Error('git exploded'));
      await h.svc.updateFromTarget(WS, USER, 7);

      h.git.resolvePrShas = vi
        .fn()
        .mockResolvedValueOnce({ baseSha: 'b'.repeat(40), headSha: MERGED_HEAD })
        .mockResolvedValue({ baseSha: 'b'.repeat(40), headSha: THIRD });
      const second = await h.svc.updateFromTarget(WS, USER, 7);
      expect(second).not.toHaveProperty('approvalCarryNotice');
      h.changeRequestReview.carryApprovalsForward.mockClear();

      await h.svc.getChangeRequestDetail(7, { workspaceId: WS });
      expect(h.changeRequestReview.carryApprovalsForward.mock.calls.map((c) => [c[1], c[2]])).toEqual([
        [HEAD, MERGED_HEAD],
        [MERGED_HEAD, THIRD],
      ]);
    });

    it('two reads at once replay the owed carry once, and neither answers before it is done', async () => {
      const h = harness({ changedPathsError: new Error('git exploded') });
      await h.svc.updateFromTarget(WS, USER, 7);
      h.git.pathsChangedBetween.mockReset().mockResolvedValue([]);
      // The copy is held open, so both reads are in flight together.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      h.changeRequestReview.carryApprovalsForward.mockImplementation(async () => {
        await held;
        return 1;
      });
      const done: string[] = [];
      const first = h.svc.getChangeRequestDetail(7, { workspaceId: WS }).then(() => done.push('first'));
      const second = h.svc.getChangeRequestDetail(7, { workspaceId: WS }).then(() => done.push('second'));
      await new Promise((r) => setTimeout(r, 20));
      // Neither read answers before the rows it reports are written.
      expect(done).toEqual([]);
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(1);

      release();
      await Promise.all([first, second]);
      expect(done).toHaveLength(2);
      expect(h.changeRequestReview.carryApprovalsForward).toHaveBeenCalledTimes(1);
    });
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
