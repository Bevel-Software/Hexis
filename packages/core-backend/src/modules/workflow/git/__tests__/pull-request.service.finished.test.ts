import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PullRequestService } from '../pull-request.service.js';
import type { GitService } from '../git.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { prMergeLog } from '../../../database/schema.js';
import { AppliedChangeMismatchError, WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { displayName, withoutAddresses } from '../finished-detail.js';
import type { PullRequestDetail } from '@bevel-software/platform-shared';

/**
 * A finished request's detail says how it ended (hx-finished-request-says-so):
 * when, who applied it (display name only), the one recorded close reason, and
 * the request's OWN verified merge commit for the "as applied" reads.
 */

const MERGE_SHA = 'c'.repeat(40);
const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const CLOSED_AT = new Date('2026-10-10T09:30:00Z');

interface MergeLogRow {
  name: string;
  headSha?: string;
  succeeded?: boolean;
  hasError?: boolean;
  startedAt?: Date;
}

const PROPOSAL_HEAD = '9'.repeat(40);

function harness(
  over: Record<string, unknown> = {},
  opts: {
    mergeLog?: MergeLogRow[];
    mismatch?: boolean;
    mergeLogThrows?: boolean;
    headNotInClone?: boolean;
    targetUnreachable?: boolean;
  } = {},
) {
  const row = {
    number: 4,
    sourceBranch: 'feature/x',
    targetBranch: 'main',
    title: 'A proposal',
    body: 'why it was needed',
    authorEmail: 'juan@bevel.software',
    authorName: 'Juan',
    state: 'merged',
    mergedSha: MERGE_SHA,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: null,
    closedAt: CLOSED_AT,
    applyFailureReason: null,
    applyFailureConflicts: null,
    applyFailedAt: null,
    applyFailedByName: null,
    applyFailureKind: null,
    closedReason: null,
    ...over,
  };
  const mergeLogWhere = vi.fn();
  const db = {
    select: (cols?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === prMergeLog) {
          // Never the email beside the name, nor the error text: only whether
          // an attempt recorded one.
          expect(Object.keys(cols ?? {})).toEqual(['name', 'headSha', 'succeeded', 'hasError', 'startedAt']);
          return {
            where: async (cond: unknown) => {
              mergeLogWhere(cond);
              // This request's attempts, and no other request's.
              expect(cond).toEqual(eq(prMergeLog.prNumber, row.number));
              expect(cond).not.toEqual(eq(prMergeLog.prNumber, row.number + 1));
              if (opts.mergeLogThrows) throw new Error('db down');
              return (opts.mergeLog ?? []).map((r, i) => ({
                succeeded: true,
                hasError: false,
                startedAt: new Date(Date.UTC(2026, 9, 10, 9, i)),
                ...r,
              }));
            },
          };
        }
        return { where: () => ({ limit: async () => [row] }) };
      },
    }),
  } as unknown as Database;
  const workspace = {
    ensureRemotesFetched: async () => undefined,
    findAnyWorkspaceId: async () => 'ws',
  } as unknown as WorkspaceService;
  const appliedChangeShas = vi.fn(async () => {
    if (opts.mismatch) {
      throw new AppliedChangeMismatchError(`commit ${MERGE_SHA} is not change request #4's merge`);
    }
    return { baseSha: BASE_SHA, headSha: HEAD_SHA };
  });
  const changedFilesOfProposalHead = vi.fn(async () => {
    if (opts.headNotInClone) throw new WorkflowValidationError('commit is not in this clone');
    if (opts.targetUnreachable) throw new Error('could not refresh main');
    return [
      {
        path: 'Knowledge/Proposed.md',
        status: 'modified' as const,
        additions: 3,
        deletions: 2,
        patch: '@@',
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ];
  });
  const git = {
    changedFilesOfProposalHead,
    appliedChangeShas,
    changedFilesOfAppliedChange: async () => [
      {
        path: 'Knowledge/A.md',
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1 @@',
        isBinary: false,
        sha: '',
        rawUrl: '',
      },
    ],
    resolvePrShas: async () => ({ baseSha: BASE_SHA, headSha: HEAD_SHA }),
    changedFilesForPr: async () => [],
    forkPointForPr: async () => ({ mergeBaseSha: BASE_SHA, behind: false }),
    pathsChangedBetween: async () => [],
  } as unknown as GitService;
  const access = { canWriteAtRef: async () => false } as unknown as IAccessControl;
  const svc = new PullRequestService(db, workspace, access, git);
  return { svc, row, mergeLogWhere, appliedChangeShas, changedFilesOfProposalHead };
}

describe('PullRequestService.getPrDetail — how a finished request ended', () => {
  it('an applied request names its applier, when, and its own verified merge commit', async () => {
    const { svc } = harness({}, { mergeLog: [{ name: 'Robin Lee' }] });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished).toEqual({
      at: CLOSED_AT.toISOString(),
      appliedBy: { name: 'Robin Lee' },
      closedReason: null,
      appliedSha: MERGE_SHA,
    });
    // The summary line counts the change as applied: the merge commit's files.
    expect(detail?.files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['Knowledge/A.md', 2, 1],
    ]);
  });

  it('an applied request with no succeeded merge-log row names nobody', async () => {
    const { svc } = harness({}, { mergeLog: [] });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({
      appliedBy: null,
      at: CLOSED_AT.toISOString(),
    });
  });

  it('a failed merge-log read reads as no applier, never as no answer', async () => {
    const { svc } = harness({}, { mergeLogThrows: true });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ appliedBy: null, appliedSha: MERGE_SHA });
  });

  it('never sends the recorded sha when it is not the request\'s own merge commit', async () => {
    // The apply made no commit: `merged_sha` is the target tip, usually
    // another request's merge. The verified path refuses it, and so does the
    // finished view's sha.
    const { svc } = harness({}, { mergeLog: [{ name: 'Robin Lee' }], mismatch: true });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished).toMatchObject({ appliedSha: null, appliedBy: { name: 'Robin Lee' } });
    // No recorded head to read its own proposal from: no files, never the
    // other request's.
    expect(detail?.files).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(MERGE_SHA);
  });

  it('checks the recorded merge commit against the head its apply logged', async () => {
    // A `(#4)` on the target may be another deployment's #4; only a commit
    // that merged this request's own head is read as applied.
    const { svc, appliedChangeShas } = harness({}, { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }] });
    await svc.getPrDetail(4);
    expect(appliedChangeShas).toHaveBeenCalledWith('ws', {
      number: 4,
      mergeSha: MERGE_SHA,
      title: 'A proposal',
      headSha: PROPOSAL_HEAD,
    });
  });

  it('a recorded commit that merged another head shows the request\'s own proposal, never that commit', async () => {
    const { svc, changedFilesOfProposalHead } = harness(
      {},
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }], mismatch: true },
    );
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished).toMatchObject({ appliedSha: null });
    expect(changedFilesOfProposalHead).toHaveBeenCalledWith('ws', 'main', PROPOSAL_HEAD, {});
    expect(detail?.files.map((f) => f.path)).toEqual(['Knowledge/Proposed.md']);
  });

  it('a merged row recording no merge commit sends no sha', async () => {
    const { svc, appliedChangeShas } = harness({ mergedSha: null }, { mergeLog: [{ name: 'Robin Lee' }] });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ appliedSha: null });
    expect(appliedChangeShas).not.toHaveBeenCalled();
  });

  it('names the newest succeeded attempt, past failed and older ones', async () => {
    const { svc } = harness(
      {},
      {
        mergeLog: [
          { name: 'Newest Failure', succeeded: false, hasError: true, startedAt: new Date('2026-10-10T09:20:00Z') },
          { name: 'Robin Lee', startedAt: new Date('2026-10-10T09:10:00Z') },
          { name: 'Older Success', startedAt: new Date('2026-10-09T09:00:00Z') },
        ],
      },
    );
    expect((await svc.getPrDetail(4))?.finished?.appliedBy).toEqual({ name: 'Robin Lee' });
  });

  it('names the attempt that pushed, not whoever finalized it afterwards', async () => {
    const { svc } = harness(
      {},
      {
        mergeLog: [
          { name: 'Robin Lee', succeeded: false, hasError: false, startedAt: new Date('2026-10-10T09:00:00Z') },
          { name: 'Dana Finalizer', succeeded: true, hasError: true, startedAt: new Date('2026-10-10T10:00:00Z') },
        ],
      },
    );
    expect((await svc.getPrDetail(4))?.finished?.appliedBy).toEqual({ name: 'Robin Lee' });
  });

  it('a warm read of an applied request with its own commit reads no merge log', async () => {
    const h = harness({}, { mergeLog: [{ name: 'Robin Lee' }] });
    // The cold read asks for the applier once, and caches its answer.
    const cold = await h.svc.getPrDetail(4);
    expect(h.mergeLogWhere).toHaveBeenCalledTimes(1);
    // The warm read is that answer, with no further query.
    expect(await h.svc.getPrDetail(4)).toBe(cold);
    expect(h.mergeLogWhere).toHaveBeenCalledTimes(1);
  });

  it('a closed request says when, names nobody, and reads no merge log', async () => {
    const { svc, mergeLogWhere } = harness({ state: 'closed', mergedSha: null });
    expect((await svc.getPrDetail(4))?.finished).toEqual({
      at: CLOSED_AT.toISOString(),
      appliedBy: null,
      closedReason: null,
      appliedSha: null,
    });
    expect(mergeLogWhere).not.toHaveBeenCalled();
  });

  it('a request closed because the knowledge base moved carries that reason', async () => {
    const { svc } = harness({ state: 'closed', mergedSha: null, closedReason: 'repository-replaced' });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ closedReason: 'repository-replaced' });
  });

  it('an unknown close reason is not passed through', async () => {
    const { svc } = harness({ state: 'closed', mergedSha: null, closedReason: 'something-else' });
    expect((await svc.getPrDetail(4))?.finished).toMatchObject({ closedReason: null });
  });

  it('an open request carries no finished facts', async () => {
    const { svc, mergeLogWhere } = harness({ state: 'open', mergedSha: null, closedAt: null });
    expect((await svc.getPrDetail(4))?.finished ?? null).toBeNull();
    expect(mergeLogWhere).not.toHaveBeenCalled();
  });

  it('no email address anywhere in a finished answer, even when the recorded name is one', async () => {
    const { svc } = harness({}, { mergeLog: [{ name: 'robin@bevel.software' }] });
    const detail = await svc.getPrDetail(4);
    expect(detail?.finished?.appliedBy).toBeNull();
    const json = JSON.stringify(detail);
    expect(json).not.toContain('robin@bevel.software');
    expect(json).not.toContain('juan@bevel.software');
  });

  it('a cached OPEN detail never answers for the same request once it is applied', async () => {
    // The merge commit's parents are the two tips the open detail was read
    // at, so only the state tells the two answers apart.
    const h = harness({ state: 'open', mergedSha: null, closedAt: null }, { mergeLog: [{ name: 'Robin Lee' }] });
    const open = await h.svc.getPrDetail(4);
    expect(open?.state).toBe('open');
    expect([open?.headSha, open?.baseSha]).toEqual([HEAD_SHA, BASE_SHA]);
    // Applied: same two shas, as the merge commit's parents.
    Object.assign(h.row, { state: 'merged', mergedSha: MERGE_SHA, closedAt: CLOSED_AT });
    const detail = await h.svc.getPrDetail(4);
    expect(detail?.state).toBe('merged');
    expect(detail?.finished?.appliedBy).toEqual({ name: 'Robin Lee' });
  });
});

describe('PullRequestService.getPrDetail — an apply that made no commit of its own', () => {
  it('lists the files it proposed, from the head its own apply recorded, with no sha to diff', async () => {
    const { svc, changedFilesOfProposalHead } = harness(
      { mergedSha: null },
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }] },
    );
    const detail = await svc.getPrDetail(4);
    expect(changedFilesOfProposalHead).toHaveBeenCalledWith('ws', 'main', PROPOSAL_HEAD, {});
    expect(detail?.files.map((f) => f.path)).toEqual(['Knowledge/Proposed.md']);
    expect(detail?.finished).toMatchObject({ appliedSha: null, appliedBy: { name: 'Robin Lee' } });
  });

  it("does the same when the recorded sha is another request's commit, and never reads that commit", async () => {
    const { svc, changedFilesOfProposalHead } = harness(
      {},
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }], mismatch: true },
    );
    const detail = await svc.getPrDetail(4);
    expect(changedFilesOfProposalHead).toHaveBeenCalledWith('ws', 'main', PROPOSAL_HEAD, {});
    expect(detail?.files.map((f) => f.path)).toEqual(['Knowledge/Proposed.md']);
    expect(detail?.finished?.appliedSha).toBeNull();
    expect(JSON.stringify(detail)).not.toContain(MERGE_SHA);
  });

  it('answers no files when that head is no longer in the clone', async () => {
    const { svc } = harness(
      { mergedSha: null },
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }], headNotInClone: true },
    );
    const detail = await svc.getPrDetail(4);
    expect(detail?.files).toEqual([]);
    expect(detail?.finished).toMatchObject({ appliedSha: null, appliedBy: { name: 'Robin Lee' } });
  });

  it('answers no files, never a stale diff, when the target cannot be refreshed', async () => {
    const { svc } = harness(
      { mergedSha: null },
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }], targetUnreachable: true },
    );
    const detail = await svc.getPrDetail(4);
    expect(detail?.files).toEqual([]);
    expect(detail?.finished).toMatchObject({ appliedSha: null, appliedBy: { name: 'Robin Lee' } });
  });

  it('does not reach for the head when the request has its own verified merge commit', async () => {
    const { svc, changedFilesOfProposalHead } = harness(
      {},
      { mergeLog: [{ name: 'Robin Lee', headSha: PROPOSAL_HEAD }] },
    );
    const detail = await svc.getPrDetail(4);
    expect(changedFilesOfProposalHead).not.toHaveBeenCalled();
    expect(detail?.files.map((f) => f.path)).toEqual(['Knowledge/A.md']);
  });
});

describe('withoutAddresses — the detail the app route serves', () => {
  /**
   * The ordinary apply: the applier approves every file, then applies. Their
   * approval is on the answer, and so would be their address.
   */
  function appliedDetail(state: 'merged' | 'closed' | 'open'): PullRequestDetail {
    return {
      number: 4,
      state,
      title: 'A proposal',
      author: { login: 'user-0123456789ab', name: 'Sam Author' },
      appAuthor: { name: 'Sam Author' },
      finished: state === 'open' ? null : { at: null, appliedBy: { name: 'Robin Lee' }, closedReason: null, appliedSha: null },
      approvals: [
        {
          path: 'Knowledge/A.md',
          eligibleApprovers: { roles: ['Admin'], users: [{ name: 'Owner One', email: 'owner@bevel.software' }] },
          approvedBy: [
            {
              email: 'robin@bevel.software',
              name: 'Robin Lee',
              approvedAt: '2026-10-10T09:00:00Z',
              isStale: false,
              isSelfApproval: false,
            },
          ],
          isApproved: true,
          inMergeGate: true,
          viewerCanApprove: true,
        },
      ],
      comments: [
        { id: 'c1', author: { email: 'dana@bevel.software', name: 'Dana Admin' }, body: 'looks good' },
      ],
    } as unknown as PullRequestDetail;
  }

  it('sends no email address of any person on an applied request, and keeps the names', () => {
    const json = JSON.stringify(withoutAddresses(appliedDetail('merged')));
    expect(json).not.toMatch(/@bevel\.software/);
    expect(json).toContain('Robin Lee');
    expect(json).toContain('Owner One');
    expect(json).toContain('Sam Author');
  });

  it('blanks a name that is itself an address, as the applier\'s is', () => {
    const detail = appliedDetail('merged');
    detail.author = { login: 'user-0123456789ab', name: 'sam@bevel.software' };
    detail.appAuthor = { name: 'sam@bevel.software' };
    detail.approvals[0].approvedBy[0].name = 'robin@bevel.software';
    detail.approvals[0].eligibleApprovers.users[0].name = 'owner@bevel.software';
    const scrubbed = withoutAddresses(detail);
    expect(JSON.stringify(scrubbed)).not.toMatch(/@/);
    expect(scrubbed.appAuthor).toEqual({ name: '' });
    expect(scrubbed.author).toEqual({ login: 'user-0123456789ab', name: '' });
    expect(scrubbed.approvals[0].approvedBy[0].name).toBe('');
  });

  it('drops the comments: none is shown, and their free text can carry an address', () => {
    const detail = appliedDetail('merged');
    detail.comments[0].body = 'ping dana@bevel.software';
    expect(withoutAddresses(detail).comments).toEqual([]);
  });

  it("keeps the author's own title and description as written", () => {
    const detail = appliedDetail('merged');
    detail.body = 'Questions to sales@bevel.software.';
    expect(withoutAddresses(detail).body).toBe('Questions to sales@bevel.software.');
  });

  it('nor on a closed one', () => {
    expect(JSON.stringify(withoutAddresses(appliedDetail('closed')))).not.toMatch(/@/);
  });

  it('leaves an open request untouched: its Undo compares the viewer with its approvers', () => {
    const open = appliedDetail('open');
    expect(withoutAddresses(open)).toBe(open);
  });
});

describe('PullRequestService.getPrDetail — which merge-log attempt was the apply', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 10, 9, minute));
  const attempt = (name: string, minute: number, succeeded: boolean, hasError: boolean) => ({
    name,
    headSha: String(minute).repeat(40).slice(0, 40),
    succeeded,
    hasError,
    startedAt: at(minute),
  });
  /**
   * The applier the detail names and the head it reads the proposal from —
   * with no merge commit of its own, the head the apply recorded is what the
   * request's files are read from, so the head it chose is observable.
   */
  async function applyOf(mergeLog: MergeLogRow[]) {
    const { svc, changedFilesOfProposalHead } = harness({ mergedSha: null }, { mergeLog });
    const detail = await svc.getPrDetail(4);
    const calls = changedFilesOfProposalHead.mock.calls as unknown as unknown[][];
    return { appliedBy: detail?.finished?.appliedBy ?? null, head: calls[0]?.[2] ?? null };
  }

  it('is nobody, and no head, without a succeeded attempt', async () => {
    expect(await applyOf([])).toEqual({ appliedBy: null, head: null });
    expect(await applyOf([attempt('A', 1, false, true), attempt('B', 2, false, false)])).toEqual({
      appliedBy: null,
      head: null,
    });
  });
  it('takes the newest succeeded attempt, whatever order the rows come in', async () => {
    const latest = attempt('New', 3, true, false);
    expect(await applyOf([attempt('Old', 1, true, false), latest, attempt('Bad', 4, false, true)])).toEqual({
      appliedBy: { name: 'New' },
      head: latest.headSha,
    });
  });
  it("a finalization names the begun attempt before it, with that attempt's head", async () => {
    const pushed = attempt('Robin', 2, false, false);
    expect(await applyOf([attempt('Dana', 5, true, true), pushed, attempt('Failed', 1, false, true)])).toEqual({
      appliedBy: { name: 'Robin' },
      head: pushed.headSha,
    });
  });
  it('a finalization with no begun attempt behind it names nobody, and reads its own head', async () => {
    const fin = attempt('Dana', 5, true, true);
    expect(await applyOf([fin, attempt('Failed', 1, false, true)])).toEqual({ appliedBy: null, head: fin.headSha });
  });
  it('a begun attempt newer than the finalization is not the one it finalized', async () => {
    expect((await applyOf([attempt('Dana', 5, true, true), attempt('Later', 6, false, false)])).appliedBy).toBeNull();
  });
});

describe('PullRequestService.getPrDetail — how the applier is named', () => {
  async function appliedBy(name: string) {
    const { svc } = harness({}, { mergeLog: [{ name }] });
    return (await svc.getPrDetail(4))?.finished?.appliedBy ?? null;
  }

  it('keeps a display name, trimmed', async () => {
    expect(await appliedBy('  Robin Lee ')).toEqual({ name: 'Robin Lee' });
  });
  it('drops a blank name', async () => {
    expect(await appliedBy('')).toBeNull();
    expect(await appliedBy('   ')).toBeNull();
  });
  it('drops anything shaped like an email address', async () => {
    expect(await appliedBy('robin@bevel.software')).toBeNull();
    expect(await appliedBy('Robin <robin@bevel.software>')).toBeNull();
  });
});

describe('displayName — one rule for every person on a finished request', () => {
  it.each(['  Robin Lee ', '', '   ', 'robin@bevel.software', 'Robin <robin@bevel.software>'])(
    'the applier and the people on the detail are named alike for %j',
    async (name) => {
      const { svc } = harness({}, { mergeLog: [{ name }] });
      const shown = displayName(name);
      expect((await svc.getPrDetail(4))?.finished?.appliedBy).toEqual(shown === null ? null : { name: shown });
    },
  );
  it('keeps a display name, trimmed, and refuses an address', () => {
    expect(displayName(' Robin Lee ')).toBe('Robin Lee');
    expect(displayName('robin@bevel.software')).toBeNull();
    expect(displayName(null)).toBeNull();
    expect(displayName(undefined)).toBeNull();
  });
});
