import { describe, it, expect, vi } from 'vitest';

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ReviewWorkflowService } from '../review-workflow.service.js';
import { changeRequests, prMergeLog } from '../../../database/schema.js';
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

/**
 * Every write the merge performs, in order, with the table it targeted and
 * whether it was an insert or an update — the ORDER is part of what one of the
 * tests below pins.
 */
type Captured = { kind: 'insert' | 'update'; table: unknown; values: Record<string, unknown> };

/**
 * What the row says, and whether the CAS wins, are PARAMETERS, not constants.
 * `mergePr` and `finalizeAlreadyApplied` both re-validate the lifecycle against
 * the row rather than against the caller's `state` argument, and a stub that
 * always answers `open` and always wins leaves those paths unreachable — a
 * regression that dropped one would still pass (cubic P3 on #347).
 *
 * `rows` is consumed in order and its last entry repeats, so a test can say
 * what the row looked like when the attempt started and what it says when the
 * lost CAS is explained.
 */
function makeDb(
  captured: Captured[],
  {
    rows = [CR_ROW],
    casWon = true,
    begunLog = true,
  }: { rows?: Record<string, unknown>[]; casWon?: boolean; begunLog?: boolean } = {},
): Database {
  let crReads = 0;
  const thenable = (data: unknown) => {
    const p = Promise.resolve(data) as Promise<unknown> & { limit: () => Promise<unknown> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  /**
   * What the CAS compares against: the row's state at the moment of the
   * update. `casWon` says the row is still open then; a lost CAS means it is
   * what the LAST row says (the terminal state the lost CAS is explained by).
   */
  const stateAtCas = casWon ? 'open' : String(rows[rows.length - 1]?.state ?? 'merged');
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // The merge log begun by the attempt that pushed and crashed —
          // `succeeded: false`, no error — is what makes a retry look for its
          // commit at all.
          if (table === prMergeLog) return thenable(begunLog ? [{ id: 'merge-log-0' }] : []);
          if (table !== changeRequests) return thenable([]);
          const row = rows[Math.min(crReads, rows.length - 1)];
          crReads += 1;
          return thenable([row]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        captured.push({ kind: 'insert', table, values });
        return { returning: async () => [{ id: 'merge-log-1' }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        captured.push({ kind: 'update', table, values });
        return {
          where: (predicate: SQL) => {
            const t = thenable(undefined) as unknown as Promise<unknown> & {
              returning: () => Promise<unknown>;
            };
            // The CAS is answered FROM THE WHERE CLAUSE, not from a flag: the
            // update of the change request row lands only if the row is in
            // the state the predicate asks for. A predicate that no longer
            // guards on `state = 'open'` would therefore land on a terminal
            // row here — which is the race this test file exists to pin, so
            // dropping the guard fails the lost-CAS tests below instead of
            // passing them by a stub that answered from `casWon` alone.
            const { sql, params } = new PgDialect().sqlToQuery(predicate);
            const guardsOpen = /"state"/.test(sql) && params.includes('open');
            const lands = table !== changeRequests || !guardsOpen || stateAtCas === 'open';
            t.returning = () => Promise.resolve(lands ? [{ id: CR_ROW.id }] : []);
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
  const crUpdate = () => captured.find((c) => c.kind === 'update' && c.table === changeRequests)?.values;
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

/**
 * The retry the row-recording fix is FOR, reached the way production reaches it.
 *
 * When an attempt pushes the merge commit and then fails to write the row, the
 * request stays open with its change already on the target — so it differs from
 * the target by nothing, its file list is empty, and the approval gate refuses
 * the next attempt ("no file changes to approve") before any merge runs. The
 * recovery inside `mergeChangeRequest` is therefore never reached from the app,
 * and the request stays fileless and un-appliable for good. The gate has to ask
 * the ownership question itself.
 */
function makeStuckService(
  own: string | null,
  // The two states a merge is decided against, kept APART because the service
  // treats them apart: `gateState` is the caller's (what drove the gate it
  // clicked), `rowState` is the authoritative row's. A stale caller passing
  // 'open' for a row that is already terminal is exactly what the row-level
  // guard is for.
  {
    gateState = 'open',
    rowState = 'open',
    casWon = true,
    // What the row says when the lost CAS is explained — a cancel closes a
    // request just as a merge does, and the audit line must not guess.
    stateAfterCas = 'merged',
    // Whether an earlier attempt left a begun, never-completed merge-log row —
    // the only evidence that there may be a pushed commit to recover.
    begunLog = true,
  }: {
    gateState?: string;
    rowState?: string;
    casWon?: boolean;
    stateAfterCas?: string;
    begunLog?: boolean;
  } = {},
) {
  const rows = [{ ...CR_ROW, state: rowState }, { ...CR_ROW, state: stateAfterCas }];
  const captured: Captured[] = [];
  const mergeChangeRequest = vi.fn<(...args: unknown[]) => Promise<AppliedMergeResult>>(async () => ({
    kind: 'merged',
    sha: 'should-not-be-reached',
    mergeCommit: null,
  }));
  const appliedMergeCommitOnTarget = vi.fn(async () => own);
  const workspace = {
    getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
  } as unknown as WorkspaceService;
  const svc = new ReviewWorkflowService(
    makeDb(captured, { rows, casWon, begunLog }),
    {} as unknown as IAccessControl,
    workspace,
    { mergeChangeRequest, appliedMergeCommitOnTarget } as unknown as GitService,
  );
  // NO approvals: an already-applied request has no file to approve, which is
  // exactly what makes it indistinguishable from an empty one at the gate.
  const merge = () =>
    svc.mergePr(CR_ROW.number, USER, HEAD_SHA, [], gateState as 'open', CR_ROW.title, BASE, 'ws-1');
  const crUpdate = () => captured.find((c) => c.kind === 'update' && c.table === changeRequests)?.values;
  return { merge, crUpdate, captured, mergeChangeRequest, appliedMergeCommitOnTarget, workspace };
}

describe('mergePr — a request whose merge commit was pushed but never recorded', () => {
  it('asks git only when the database shows an attempt that began and never completed', async () => {
    // A genuinely empty request — nothing on the target, no attempt behind it
    // — is refused as it always was, and the refusal touches no clone and no
    // remote: the probe that fetches the target runs only behind the one
    // piece of evidence a crashed attempt leaves, its begun merge-log row.
    const { merge, appliedMergeCommitOnTarget, workspace } = makeStuckService('a-commit', { begunLog: false });
    await expect(merge()).rejects.toThrow(/no file changes to approve/i);
    expect(appliedMergeCommitOnTarget).not.toHaveBeenCalled();
    expect((workspace as unknown as { getOrCreateForBranch: ReturnType<typeof vi.fn> }).getOrCreateForBranch).not.toHaveBeenCalled();
  });

  it('hands the stored title to the probe, so a merge commit in the old message format is recognised', async () => {
    const { merge, appliedMergeCommitOnTarget } = makeStuckService('a-commit');
    await merge();
    expect(appliedMergeCommitOnTarget).toHaveBeenCalledWith('ws-base', BASE, CR_ROW.number, CR_ROW.title);
  });

  it('records that commit instead of refusing, and merges nothing', async () => {
    const { merge, crUpdate, mergeChangeRequest, appliedMergeCommitOnTarget } =
      makeStuckService('the-commit-the-first-attempt-pushed');

    const result = await merge();

    expect(crUpdate()).toMatchObject({
      state: 'merged',
      mergedSha: 'the-commit-the-first-attempt-pushed',
    });
    expect(result.sha).toBe('the-commit-the-first-attempt-pushed');
    // Asked of the TARGET branch's own workspace, for this request's number.
    expect(appliedMergeCommitOnTarget).toHaveBeenCalledWith('ws-base', BASE, CR_ROW.number, CR_ROW.title);
    // Nothing was merged, committed or pushed: the merge already happened.
    expect(mergeChangeRequest).not.toHaveBeenCalled();
  });

  it('still refuses a request that owns no merge commit', async () => {
    // The genuinely empty request. The hard block is the right answer for it,
    // and the probe is what tells the two apart.
    const { merge, crUpdate, mergeChangeRequest } = makeStuckService(null);

    await expect(merge()).rejects.toThrow('no file changes to approve');

    expect(crUpdate()).toBeUndefined();
    expect(mergeChangeRequest).not.toHaveBeenCalled();
  });

  it('does not go looking when the hard block is the request\'s state', async () => {
    // A closed or merged request earns its own refusal, and must keep it: the
    // recovery is only ever about the empty-file-set block.
    const { merge, appliedMergeCommitOnTarget, crUpdate } = makeStuckService('a-commit', { gateState: 'closed', rowState: 'closed' });

    await expect(merge()).rejects.toThrow('This pull request is closed.');

    expect(appliedMergeCommitOnTarget).not.toHaveBeenCalled();
    expect(crUpdate()).toBeUndefined();
  });

  it('refuses when the AUTHORITATIVE row is already terminal, whatever the caller passed', async () => {
    // The caller's gate inputs were resolved before a concurrent apply landed,
    // so it still says `open` while the row says `merged`. The recovery runs
    // ahead of `mergePr`'s own lifecycle re-check, so its own row-state guard is
    // the only thing between a stale click and a second finalization.
    const { merge, crUpdate, appliedMergeCommitOnTarget } = makeStuckService('a-commit', {
      gateState: 'open',
      rowState: 'merged',
    });

    await expect(merge()).rejects.toThrow('no file changes to approve');

    expect(appliedMergeCommitOnTarget).not.toHaveBeenCalled();
    expect(crUpdate()).toBeUndefined();
  });

  it('logs the attempt before it finalizes the row, and completes the log after', async () => {
    // Order matters: a log write that failed after the CAS would leave a request
    // recorded as merged with no attempt behind it, and the caller erroring on a
    // request that IS merged. The attempt goes in first, carrying the commit it
    // is about, and is completed once the row is won.
    const { merge, captured } = makeStuckService('the-commit-the-first-attempt-pushed');

    await merge();

    const inserted = captured.find((c) => c.kind === 'insert');
    expect(inserted?.values).toMatchObject({ succeeded: false, mergeMethod: 'merge' });
    expect(String(inserted?.values.error)).toContain('the-commit-the-first-attempt-pushed');
    // The log's completion comes AFTER the change request row is finalized.
    const order = captured.map((c) => (c.kind === 'insert' ? 'log-insert' : c.table === changeRequests ? 'cr' : 'log-update'));
    expect(order).toEqual(['log-insert', 'cr', 'log-update']);
    expect(captured[2].values).toMatchObject({ succeeded: true });
  });
  it('names the state the row actually ended in when the CAS is lost to a CANCEL', async () => {
    // A cancel closes a request exactly as a merge does, and both lose this CAS.
    // Filing a cancellation as "a concurrent merge won" sends whoever reads
    // pr_merge_log afterwards to the wrong cause (cubic P2 on #347).
    const { merge, captured } = makeStuckService('a-commit', {
      casWon: false,
      stateAfterCas: 'closed',
    });

    await expect(merge()).rejects.toThrow('This change request is closed.');

    const logUpdate = captured.filter((c) => c.kind === 'update' && c.table !== changeRequests).pop();
    expect(logUpdate?.values).toMatchObject({ succeeded: false });
    expect(String(logUpdate?.values.error)).toBe(
      'Change request was no longer open (closed); this attempt did not finalize it.',
    );
    expect(String(logUpdate?.values.error)).not.toContain('concurrent');
  });

  it('says merged, and refuses as merged, when the CAS is lost to another merge', async () => {
    const { merge, captured } = makeStuckService('a-commit', {
      casWon: false,
      stateAfterCas: 'merged',
    });

    await expect(merge()).rejects.toThrow('This change request has already been merged.');

    const logUpdate = captured.filter((c) => c.kind === 'update' && c.table !== changeRequests).pop();
    expect(String(logUpdate?.values.error)).toBe(
      'Change request was no longer open (merged); this attempt did not finalize it.',
    );
  });
});
