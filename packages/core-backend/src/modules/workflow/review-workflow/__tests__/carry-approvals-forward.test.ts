import { describe, it, expect, vi } from 'vitest';
import type { PullRequestFile } from '@bevel-software/platform-shared';
import { ReviewWorkflowService } from '../review-workflow.service.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../../git/git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';

/**
 * A change request brings itself up to date when someone who may update it
 * opens it. That merge is a commit the APPROVERS did not make — so the
 * approvals it did not disturb have to survive it, or every stale request
 * would cost its reviewers a second round over text nobody changed.
 *
 * What decides survival is content: the paths the merge moved lose their
 * approvals, everything else keeps them. These pin both halves — the rows
 * that get written, and that the written rows then COUNT at the new head.
 */

const PR = 7;
const OLD_HEAD = 'a'.repeat(40);
const NEW_HEAD = 'd'.repeat(40);
const APPROVED_AT = new Date('2026-09-20T11:00:00.000Z');

interface ApprovalRow {
  prNumber: number;
  path: string;
  approverEmail: string;
  approverName: string;
  headSha: string;
  approvedAt: Date;
}

const row = (path: string, over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  prNumber: PR,
  path,
  approverEmail: 'bob@bevel.software',
  approverName: 'Bob',
  headSha: OLD_HEAD,
  approvedAt: APPROVED_AT,
  ...over,
});

/**
 * The column = value pairs a drizzle `where(...)` was built from, dug out of
 * the SQL tree. Without this the stub would answer every query the same way
 * and the head-sha filter — the thing that makes this read the approvals of
 * the head being replaced, and not some other head's — would go untested.
 */
function conditions(clause: unknown): Record<string, unknown> {
  const found: Record<string, unknown> = {};
  let column: string | null = null;
  const walk = (node: unknown) => {
    if (node === null || typeof node !== 'object') return;
    const n = node as { name?: string; value?: unknown; queryChunks?: unknown[] };
    if (Array.isArray(n.queryChunks)) {
      for (const chunk of n.queryChunks) walk(chunk);
      return;
    }
    if (typeof n.name === 'string') {
      column = n.name;
      return;
    }
    if ('value' in n && !Array.isArray(n.value) && column) {
      found[column] = n.value;
      column = null;
    }
  };
  walk(clause);
  return found;
}

/** The SQL text of a drizzle statement, literal chunks only. */
function statementText(statement: { queryChunks?: unknown[] }): string {
  return (statement.queryChunks ?? [])
    .flatMap((c) => (c as { value?: unknown }).value ?? [])
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
}

function makeService(stored: ApprovalRow[], opts: { lockError?: unknown } = {}) {
  const selected: Record<string, unknown>[] = [];
  const inserted: ApprovalRow[][] = [];
  /**
   * What the service did, in order. The carry-forward's read and write have to
   * happen INSIDE one transaction that took the per-request lock first, or a
   * revoke landing between them is silently undone — so the order is part of
   * what these tests pin, not an implementation detail.
   */
  const order: string[] = [];
  const locked: unknown[][] = [];
  /** `select`, wired to record under whichever handle it was reached through. */
  const selectVia = (label: string) => () => ({
    from: () => ({
      where: (clause: unknown) => {
        const where = conditions(clause);
        order.push(label);
        selected.push(where);
        return Promise.resolve(
          stored.filter(
            (r) =>
              (where.pr_number === undefined || r.prNumber === where.pr_number) &&
              (where.head_sha === undefined || r.headSha === where.head_sha),
          ),
        );
      },
    }),
  });
  const tx = {
    execute: async (statement: { queryChunks?: unknown[] }) => {
      const text = statementText(statement);
      if (text.includes('lock_timeout')) {
        order.push('timeout');
        return { rows: [] };
      }
      order.push('lock');
      // The lock's two keys, dug out of the tagged template's chunks: drizzle
      // keeps the literal text in `StringChunk` objects and the interpolated
      // numbers as bare primitives between them.
      locked.push((statement.queryChunks ?? []).filter((c) => typeof c === 'number'));
      if (opts.lockError) throw opts.lockError;
      return { rows: [] };
    },
    select: selectVia('select'),
    insert: () => ({
      values: (v: ApprovalRow | ApprovalRow[]) => {
        const rows = Array.isArray(v) ? v : [v];
        // The unique index is on (pr, path, approver, headSha), so a row that
        // is already there is silently dropped — modelled here so a second
        // update over the same merge stays a no-op, and `returning` answers
        // with the rows that were actually WRITTEN, as Postgres does.
        let done: ApprovalRow[] | null = null;
        const apply = () => {
          if (done) return done;
          order.push('insert');
          inserted.push(rows);
          const written: ApprovalRow[] = [];
          for (const r of rows) {
            const dup = stored.some(
              (e) =>
                e.prNumber === r.prNumber &&
                e.path === r.path &&
                e.approverEmail === r.approverEmail &&
                e.headSha === r.headSha,
            );
            if (!dup) {
              // `approvedAt` has a column default, which an insert that omits
              // it (`approveFile`) relies on.
              const landed = { ...r, approvedAt: r.approvedAt ?? new Date() };
              stored.push(landed);
              written.push(landed);
            }
          }
          done = written;
          return written;
        };
        // Awaited directly by `approveFile`, and through `returning()` by the
        // carry-forward — one write either way.
        return {
          onConflictDoNothing: () => ({
            returning: async () => apply(),
            then: <R,>(res: (v: ApprovalRow[]) => R, rej?: (e: unknown) => R) =>
              Promise.resolve().then(apply).then(res, rej),
          }),
        };
      },
    }),
  };
  /**
   * The pool handle, DELIBERATELY not the transaction's.
   *
   * Spreading `tx` into it made `db.select` and `tx.select` the same function,
   * so a service that took the lock and then did its read or write outside the
   * transaction recorded an identical `order` and sailed through — which is
   * the very race these tests exist to catch. Separate labels: anything
   * reached through `this.db` shows up as `db.*`, and the order assertions
   * fail. `select` stays available because `approveFile` legitimately re-reads
   * the approval states through the pool once its write has committed.
   */
  const db = {
    select: selectVia('db.select'),
    insert: () => {
      order.push('db.insert');
      throw new Error('approval rows must be written inside withApprovalLock');
    },
    transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => {
      order.push('begin');
      return fn(tx);
    },
  } as unknown as Database;
  const svc = new ReviewWorkflowService(
    db,
    {} as unknown as IAccessControl,
    {} as unknown as WorkspaceService,
    {} as unknown as GitService,
  );
  return { svc, db, stored, selected, inserted, order, locked };
}

describe('ReviewWorkflowService.carryApprovalsForward', () => {
  it('re-pins only the approvals the merge did not touch, keeping who approved and when', async () => {
    const h = makeService([
      row('Sales/Deal.md'),
      row('Sales/Terms.md', { approverEmail: 'carol@bevel.software', approverName: 'Carol' }),
      row('Sales/Pricing.md'),
    ]);

    const carried = await h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, ['Sales/Deal.md']);

    expect(carried).toBe(2);
    // Read at the head being replaced, for this request only.
    expect(h.selected[0]).toEqual({ pr_number: PR, head_sha: OLD_HEAD });
    expect(h.inserted[0]).toEqual([
      {
        prNumber: PR,
        path: 'Sales/Terms.md',
        approverEmail: 'carol@bevel.software',
        approverName: 'Carol',
        headSha: NEW_HEAD,
        // The reviewer approved THEN, not now — the merge is not an approval.
        approvedAt: APPROVED_AT,
      },
      {
        prNumber: PR,
        path: 'Sales/Pricing.md',
        approverEmail: 'bob@bevel.software',
        approverName: 'Bob',
        headSha: NEW_HEAD,
        approvedAt: APPROVED_AT,
      },
    ]);
    // The row at the old head is left alone — it is the audit trail.
    expect(h.stored.filter((r) => r.headSha === OLD_HEAD)).toHaveLength(3);
  });

  it('carries nothing when the merge touched every approved file', async () => {
    const h = makeService([row('Sales/Deal.md'), row('Sales/Terms.md')]);
    const carried = await h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, [
      'Sales/Terms.md',
      'Sales/Deal.md',
    ]);
    expect(carried).toBe(0);
    expect(h.inserted).toHaveLength(0);
  });

  it('is idempotent — running the same update twice writes the rows once', async () => {
    const h = makeService([row('Sales/Deal.md')]);
    await expect(h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, [])).resolves.toBe(1);
    // The rows were all already there, so nothing was WRITTEN — and the count
    // says so, which is what keeps the caller from re-reading the detail for a
    // merge that changed no approval at all.
    await expect(h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, [])).resolves.toBe(0);
    expect(h.stored.filter((r) => r.headSha === NEW_HEAD)).toHaveLength(1);
  });

  it('reads and writes inside one transaction that takes the per-request lock first', async () => {
    // A reviewer revoking an approval while this runs must not have it
    // resurrected by a copy taken before the delete. The lock both writes
    // share is what rules that out; taken BEFORE the read, or the read has
    // already seen the pre-revoke row.
    const h = makeService([row('Sales/Deal.md')]);
    await h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, []);
    expect(h.order).toEqual(['begin', 'timeout', 'lock', 'select', 'insert']);
    // Keyed by this request, under this file's lock class — never a bare PR
    // number that another subsystem's advisory lock could collide with.
    expect(h.locked).toEqual([[4207, PR]]);
  });

  it('does nothing at all when the head did not move', async () => {
    const h = makeService([row('Sales/Deal.md')]);
    await expect(h.svc.carryApprovalsForward(PR, OLD_HEAD, OLD_HEAD, [])).resolves.toBe(0);
    expect(h.selected).toHaveLength(0);
    expect(h.inserted).toHaveLength(0);
  });

  it('reports a lock it could not get as a retryable refusal, having written nothing', async () => {
    // A holder that wedges would otherwise park this transaction — and its
    // pooled connection — for as long as it lasts. `lock_timeout` bounds the
    // wait; what comes back says so in words the caller can act on.
    const timeout = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const h = makeService([row('Sales/Deal.md')], { lockError: timeout });

    await expect(h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, [])).rejects.toMatchObject({
      status: 503,
      payload: { kind: 'approval-write-busy', retryable: true },
    });
    // Nothing was read and nothing written: the lock is taken first for
    // exactly this reason.
    expect(h.order).toEqual(['begin', 'timeout', 'lock']);
    expect(h.inserted).toHaveLength(0);
    expect(h.stored.filter((r) => r.headSha === NEW_HEAD)).toHaveLength(0);
  });

  it('refuses a call with a head missing', async () => {
    const h = makeService([row('Sales/Deal.md')]);
    await expect(h.svc.carryApprovalsForward(PR, '', NEW_HEAD, [])).rejects.toThrow(/head shas/);
    await expect(h.svc.carryApprovalsForward(PR, OLD_HEAD, '', [])).rejects.toThrow(/head shas/);
  });
});

/**
 * An approval made WHILE a request is bringing itself up to date takes the
 * same lock the carry-forward does. Without it, an approval that landed
 * between the copy's select and its insert stayed pinned to the head the
 * update was replacing and vanished from the request it was made on.
 */
describe('ReviewWorkflowService.approveFile: written under the same lock', () => {
  const USER = { id: 'u1', email: 'bob@bevel.software', name: 'Bob' };
  const FILES: PullRequestFile[] = [
    {
      path: 'Sales/Deal.md',
      status: 'modified',
      additions: 1,
      deletions: 0,
      isBinary: false,
      sha: '',
      rawUrl: '',
    },
  ];

  it('inserts inside the transaction, and only re-reads the states after it', async () => {
    const h = makeService([]);
    const svc = new ReviewWorkflowService(
      h.db,
      {
        canWriteAtRef: async () => true,
        eligibleWritersForPathsAtRef: async (_ws: string, _ref: string, paths: string[]) =>
          new Map(
            paths.map((p) => [
              p,
              {
                roles: ['Sales'],
                users: [{ name: 'Bob', email: 'bob@bevel.software' }],
                emails: new Set(['bob@bevel.software']),
                excludedEmails: new Set<string>(),
              },
            ]),
          ),
        canWriteBatchAtRef: async () => null,
      } as unknown as IAccessControl,
      { ensureRemotesFetched: vi.fn(async () => undefined) } as unknown as WorkspaceService,
      {} as unknown as GitService,
    );

    const states = await svc.approveFile(
      PR,
      'Sales/Deal.md',
      USER,
      FILES,
      NEW_HEAD,
      'current-company-state',
      null,
      'ws-1',
    );

    // The write is inside the lock; the read that answers the UI is after it,
    // through the pool — holding a lock across it would serialize every
    // approval behind an access-control read.
    expect(h.order).toEqual(['begin', 'timeout', 'lock', 'insert', 'db.select']);
    expect(h.locked).toEqual([[4207, PR]]);
    expect(h.stored).toMatchObject([
      { prNumber: PR, path: 'Sales/Deal.md', approverEmail: 'bob@bevel.software', headSha: NEW_HEAD },
    ]);
    expect(states.find((st) => st.path === 'Sales/Deal.md')?.isApproved).toBe(true);
  });
});

/**
 * The half that matters to the reviewer: a carried row is not an archived
 * row. It has to read as a LIVE approval at the new head, and the file the
 * merge changed has to read as stale — which is the pre-existing rule
 * (`row.headSha !== headSha`), unchanged.
 */
describe('a carried approval still counts at the new head', () => {
  const file = (path: string): PullRequestFile => ({
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    isBinary: false,
    sha: '',
    rawUrl: '',
  });

  const access = {
    eligibleWritersForPathsAtRef: async (_ws: string, _ref: string, paths: string[]) =>
      new Map(
        paths.map((p) => [
          p,
          {
            roles: ['Sales'],
            users: [{ name: 'Bob', email: 'bob@bevel.software' }],
            emails: new Set(['bob@bevel.software']),
            excludedEmails: new Set<string>(),
          },
        ]),
      ),
    canWriteBatchAtRef: async () => null,
  } as unknown as IAccessControl;

  it('and the file the merge changed goes stale, exactly as before', async () => {
    const h = makeService([row('Sales/Deal.md'), row('Sales/Terms.md')]);
    await h.svc.carryApprovalsForward(PR, OLD_HEAD, NEW_HEAD, ['Sales/Deal.md']);

    const reader = new ReviewWorkflowService(
      {
        select: () => ({ from: () => ({ where: () => Promise.resolve(h.stored) }) }),
      } as unknown as Database,
      access,
      { ensureRemotesFetched: vi.fn(async () => undefined) } as unknown as WorkspaceService,
      {} as unknown as GitService,
    );

    const states = await reader.getApprovalStates(
      PR,
      [file('Sales/Deal.md'), file('Sales/Terms.md')],
      NEW_HEAD,
      'current-company-state',
      null,
      'ws-1',
    );

    const deal = states.find((s) => s.path === 'Sales/Deal.md');
    const terms = states.find((s) => s.path === 'Sales/Terms.md');
    // Touched by the merge: the approval is still on record, but stale, and
    // the file is no longer approved.
    expect(deal?.isApproved).toBe(false);
    expect(deal?.approvedBy.every((a) => a.isStale)).toBe(true);
    // Untouched: Bob's approval carried, and it is NOT stale.
    expect(terms?.isApproved).toBe(true);
    expect(terms?.approvedBy.some((a) => !a.isStale && a.email === 'bob@bevel.software')).toBe(true);
  });
});
