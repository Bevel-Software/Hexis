import { describe, it, expect } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AccountErasureService, type IErasureParticipant } from '../account-erasure.service.js';
import type { Database } from '../../database/connection.js';
import { ReviewWorkflowService } from '../../workflow/review-workflow/review-workflow.service.js';

/**
 * Erasing an account rewrites the person's name and address out of every
 * approval they ever made. One other writer COPIES those rows — a change
 * request that brings itself up to date re-pins the approvals its merge did
 * not disturb onto the new head — so a copy that read the row a moment before
 * the rewrite would insert the real address back afterwards, onto a row
 * created after the last trace of them was supposed to be gone.
 *
 * What stops it is the lock both sides take: shared per request on the copy's
 * side, exclusive on every request here. This pins that the erasure takes it,
 * that it takes it BEFORE the statement it has to cover, and that it keeps
 * holding it (a transaction-scoped lock) through the rest of the erasure.
 */

/** The table a statement names, as far as this stub needs to know. */
function tableOf(target: unknown): string {
  const t = target as Record<symbol | string, unknown>;
  for (const sym of Object.getOwnPropertySymbols(t)) {
    const name = String(t[sym]);
    if (name && name !== 'undefined' && !name.startsWith('[object')) return name;
  }
  return 'unknown';
}

/**
 * A `where` clause as the SQL it renders to.
 *
 * The sweeps' guard is a `notExists` over `users`, and it is the whole reason
 * they are safe to run at all: without it they would anonymize the approvals
 * and change requests of whoever signed in again at that address since the
 * commit. A stub that ignored its condition would pass just as happily with
 * the guard deleted — so the marker below is recorded only for a clause whose
 * SQL actually names `users`, and the assertions are on that.
 */
function whereSql(clause: unknown): string {
  return new PgDialect().sqlToQuery(clause as SQL).sql;
}

function statementText(statement: { queryChunks?: unknown[] }): string {
  return (statement.queryChunks ?? [])
    .flatMap((c) => (c as { value?: unknown }).value ?? [])
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
}

function harness(opts: { participants?: IErasureParticipant[] } = {}) {
  /** Everything the erasure did, in order, as `<verb>:<table>` / lock labels. */
  const order: string[] = [];
  const locked: unknown[][] = [];
  /** The lock statements as written, so the FUNCTION is pinned, not just its keys. */
  const lockSql: string[] = [];
  const done = Promise.resolve([]);
  const tx = {
    execute: async (statement: { queryChunks?: unknown[] }) => {
      const text = statementText(statement);
      if (text.includes('lock_timeout')) {
        order.push('timeout');
        return { rows: [] };
      }
      order.push(text.includes('_shared') ? 'gate:shared' : 'gate:exclusive');
      lockSql.push(text);
      locked.push((statement.queryChunks ?? []).filter((c) => typeof c === 'number'));
      return { rows: [] };
    },
    delete: (table: unknown) => ({
      where: () => {
        order.push(`delete:${tableOf(table)}`);
        return done;
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          order.push(`update:${tableOf(table)}`);
          return done;
        },
      }),
    }),
  };
  // A client-less drizzle instance, purely to BUILD queries. Two callers share
  // this `select`: the read that finds the user, which awaits `.limit(1)`, and
  // the sweeps' `notExists` subquery, which is handed to drizzle as a query and
  // has to render as one — a hand-rolled stand-in renders as nothing, and the
  // guard these tests are about would be invisible.
  const builder = drizzle({} as never);
  const db = {
    select: (fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) =>
          Object.assign(
            builder
              .select(fields as never)
              .from(table as never)
              .where(condition as never),
            { limit: async () => [{ id: 'u1', email: 'Bob@Bevel.software', name: 'Bob' }] },
          ),
      }),
    }),
    // Outside the transaction: the second passes, once it has committed. The
    // marker is recorded ONLY for a clause guarded on `users` — a sweep that
    // lost that guard is a sweep that rewrites a new account's rows, so it must
    // not be able to satisfy these tests.
    update: (table: unknown) => ({
      set: () => ({
        where: async (clause: unknown) => {
          const guarded = /not exists .*"users"/s.test(whereSql(clause));
          order.push(`${guarded ? 'after-commit' : 'unguarded'}:${tableOf(table)}`);
        },
      }),
    }),
    transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as Database;
  return {
    // The REAL review workflow, so what is pinned below is the contract as
    // wired: erasure asks it to rewrite the approvals inside the erasure's
    // transaction, and it is the workflow that takes the lock. Its other
    // collaborators are never reached by `eraseApprover`.
    svc: new AccountErasureService(
      db,
      new ReviewWorkflowService(db, {} as never, {} as never, {} as never),
      opts.participants ?? [],
    ),
    order,
    locked,
    lockSql,
  };
}

describe('AccountErasureService: approvals are rewritten under the approval lock', () => {
  it('takes the every-request lock exclusively, right before it anonymizes them', async () => {
    const h = harness();
    await expect(h.svc.eraseUser('u1')).resolves.toBe(true);

    const gate = h.order.indexOf('gate:exclusive');
    const approvals = h.order.indexOf('update:pr_file_approvals');
    expect(gate).toBeGreaterThan(-1);
    expect(approvals).toBeGreaterThan(-1);
    // Before the rewrite — a lock taken after it would leave the very window
    // it exists to close wide open.
    expect(gate).toBeLessThan(approvals);
    // And bounded, so a wedged writer fails the erasure loudly (its
    // transaction is atomic, so nothing is half-erased) instead of hanging.
    expect(h.order[gate - 1]).toBe('timeout');
    // Exclusive on the every-request key (0) of the approval lock's class —
    // the shared form is the per-request writers', not this.
    expect(h.locked).toEqual([[4207, 0]]);
    expect(h.order).not.toContain('gate:shared');
    // And TRANSACTION-scoped. The session-scoped `pg_advisory_lock` would
    // satisfy every assertion above and then keep an exclusive lock on a
    // pooled connection after this transaction ends — held by whatever request
    // borrows that connection next, released by nobody.
    expect(h.lockSql).toHaveLength(1);
    expect(h.lockSql[0]).toContain('pg_advisory_xact_lock');
    expect(h.lockSql[0]).not.toMatch(/pg_advisory_lock\b/);
    // Still inside the same transaction as the user row's deletion, which is
    // what keeps the lock held for the whole rewrite.
    expect(h.order.indexOf('delete:users')).toBeGreaterThan(gate);
  });

  it('sweeps the approvals once more after the commit, for anything the lock did not order', async () => {
    // The lock covers every writer that takes it, and `approveFile` re-reads
    // the account under it before writing. This is the belt to those braces:
    // one idempotent statement so the guarantee does not rest on every future
    // writer of this table remembering the lock.
    const h = harness();
    await h.svc.eraseUser('u1');

    const committed = h.order.indexOf('delete:users');
    const sweep = h.order.indexOf('after-commit:pr_file_approvals');
    expect(sweep).toBeGreaterThan(committed);
    // The change requests get the same treatment, and did before this.
    expect(h.order).toContain('after-commit:change_requests');
    // Both guarded on `users`: the marker is only recorded for a clause that
    // names it, so a sweep that dropped the `notExists` lands here instead.
    expect(h.order.filter((step) => step.startsWith('unguarded:'))).toEqual([]);
  });

  it('sweeps before the post-commit callbacks, so one that rejects cannot skip them', async () => {
    // The erasure is committed by now and `eraseUser` cannot be retried into
    // it, so a pass sequenced behind a failing callback is one that may never
    // run at all. Nothing in the sweeps depends on a callback having succeeded.
    const h = harness({
      participants: [
        {
          inTransaction: async () => async () => {
            h.order.push('callback');
            throw new Error('the external store is down');
          },
        },
      ],
    });

    await expect(h.svc.eraseUser('u1')).rejects.toThrow(/external store/);

    expect(h.order).toContain('after-commit:pr_file_approvals');
    expect(h.order).toContain('after-commit:change_requests');
    expect(h.order.indexOf('after-commit:pr_file_approvals')).toBeLessThan(
      h.order.indexOf('callback'),
    );
  });
});
