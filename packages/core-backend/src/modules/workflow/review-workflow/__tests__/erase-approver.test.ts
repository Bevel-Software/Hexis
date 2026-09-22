import { describe, it, expect } from 'vitest';
import { ReviewWorkflowService } from '../review-workflow.service.js';
import type { ApprovalTx } from '../review-workflow.interface.js';

/**
 * `eraseApprover` is the review workflow's half of account erasure: the rows
 * are this module's, the writers that race the rewrite are this module's, so
 * the lock and the statement live here and erasure only hands over its
 * transaction. This pins what that half must do with it — take the
 * every-request lock exclusively, bounded, transaction-scoped, and BEFORE the
 * rewrite — through the public method, not the lock helper.
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
  /** Everything done on the handed-over transaction, in order. */
  const order: string[] = [];
  const locked: unknown[][] = [];
  const lockSql: string[] = [];
  const sets: unknown[] = [];
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
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: async () => {
          sets.push(values);
          order.push(`update:${tableOf(table)}`);
        },
      }),
    }),
  };
  // `eraseApprover` touches nothing but the transaction it is given, so the
  // service's own collaborators are never reached.
  const svc = new ReviewWorkflowService({} as never, {} as never, {} as never, {} as never);
  return { svc, tx: tx as unknown as ApprovalTx, order, locked, lockSql, sets };
}

describe('ReviewWorkflowService.eraseApprover', () => {
  it('takes the every-request lock exclusively, bounded, right before the rewrite', async () => {
    const h = harness();
    await h.svc.eraseApprover(h.tx, 'bob@bevel.software', {
      email: 'deleted-1@erased.invalid',
      name: 'Deleted user',
    });

    expect(h.order).toEqual(['timeout', 'gate:exclusive', 'update:pr_file_approvals']);
    // Exclusive on the every-request key (0) of the approval lock's class —
    // the shared form is what the per-request writers take, not this.
    expect(h.locked).toEqual([[4207, 0]]);
    // Transaction-scoped: a session lock would outlive the caller's
    // transaction on whatever pooled connection it ran on.
    expect(h.lockSql).toHaveLength(1);
    expect(h.lockSql[0]).toContain('pg_advisory_xact_lock');
    expect(h.lockSql[0]).not.toMatch(/pg_advisory_lock\b/);
    // And the rewrite is to the placeholder identity it was given.
    expect(h.sets).toEqual([{ approverEmail: 'deleted-1@erased.invalid', approverName: 'Deleted user' }]);
  });
});
