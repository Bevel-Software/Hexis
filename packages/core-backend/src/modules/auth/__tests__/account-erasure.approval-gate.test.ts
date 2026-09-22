import { describe, it, expect } from 'vitest';
import { AccountErasureService } from '../account-erasure.service.js';
import type { Database } from '../../database/connection.js';

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

function statementText(statement: { queryChunks?: unknown[] }): string {
  return (statement.queryChunks ?? [])
    .flatMap((c) => (c as { value?: unknown }).value ?? [])
    .filter((v): v is string => typeof v === 'string')
    .join(' ');
}

function harness() {
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
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: 'u1', email: 'Bob@Bevel.software', name: 'Bob' }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    transaction: async <T,>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
  } as unknown as Database;
  return { svc: new AccountErasureService(db), order, locked, lockSql };
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
});
