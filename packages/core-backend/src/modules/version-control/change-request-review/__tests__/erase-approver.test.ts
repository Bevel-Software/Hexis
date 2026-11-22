import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ChangeRequestReviewService } from '../change-request-review.service.js';
import type { ApprovalTx } from '../change-request-review.interface.js';

/**
 * `eraseApprover` is the change-request review's half of account erasure: the rows
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
  /** The condition each rewrite was limited to, as the SQL and values it sends. */
  const wheres: { sql: string; params: unknown[] }[] = [];
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
        where: async (condition: SQL) => {
          sets.push(values);
          wheres.push(new PgDialect().sqlToQuery(condition));
          order.push(`update:${tableOf(table)}`);
        },
      }),
    }),
  };
  // `eraseApprover` touches nothing but the transaction it is given, so the
  // service's own collaborators are never reached.
  const svc = new ChangeRequestReviewService({} as never, {} as never, {} as never, {} as never);
  return { svc, tx: tx as unknown as ApprovalTx, order, locked, lockSql, sets, wheres };
}

describe('ChangeRequestReviewService.eraseApprover', () => {
  it('takes the every-request lock exclusively, bounded, right before the rewrite', async () => {
    const h = harness();
    await h.svc.eraseApprover(h.tx, 'bob@bevel.software', {
      email: 'deleted-1@erased.invalid',
      name: 'Deleted user',
    });

    // The approver's own rows, then the rows that name them as the person
    // behind a bot's approval (`modules/bots`).
    expect(h.order).toEqual(['timeout', 'gate:exclusive', 'update:pr_file_approvals', 'update:pr_file_approvals']);
    // Exclusive on the every-request key (0) of the approval lock's class —
    // the shared form is what the per-request writers take, not this.
    expect(h.locked).toEqual([[4207, 0]]);
    // Transaction-scoped: a session lock would outlive the caller's
    // transaction on whatever pooled connection it ran on.
    expect(h.lockSql).toHaveLength(1);
    expect(h.lockSql[0]).toContain('pg_advisory_xact_lock');
    expect(h.lockSql[0]).not.toMatch(/pg_advisory_lock\b/);
    // And the rewrite is to the placeholder identity it was given.
    // The blind index is rewritten with the email: nothing keyed to the
    // erased address may survive, and the email itself is ciphertext. The
    // index column is written with the address; the handle indexes it.
    expect(h.sets).toEqual([
      {
        approverEmail: 'deleted-1@erased.invalid',
        approverEmailBidx: 'deleted-1@erased.invalid',
        approverName: 'Deleted user',
      },
      {
        madeByEmail: 'deleted-1@erased.invalid',
        madeByEmailBidx: 'deleted-1@erased.invalid',
        madeByName: 'Deleted user',
      },
    ]);
    // WHICH rows: the ones whose blind index is the erased address's. The
    // address column holds randomized ciphertext, so a match on it finds
    // nothing — the rewrite would report success having rewritten no row, and
    // every approval of the erased person would keep their name.
    expect(h.wheres).toHaveLength(2);
    expect(h.wheres[1]!.sql).toMatch(/"made_by_email_bidx" = \$1$/);
    expect(JSON.stringify(h.wheres[1]!.params)).toContain('bob@bevel.software');
    expect(h.wheres[0]!.sql).toMatch(/"approver_email_bidx" = \$1$/);
    expect(h.wheres[0]!.sql).not.toMatch(/"approver_email" =/);
    expect(JSON.stringify(h.wheres[0]!.params)).toContain('bob@bevel.software');
  });
});

/**
 * `readdressIdentity` is the same shape for a bots' domain change: every
 * address this module records of the bot moves from its old address to its
 * new one, in the caller's transaction, under the same lock.
 */
describe('ChangeRequestReviewService.readdressIdentity', () => {
  it('takes the every-request lock exclusively first, then moves every recorded address by the old address\'s blind index', async () => {
    const h = harness();
    await h.svc.readdressIdentity(h.tx, 'Coder@Agent.Hexis', 'coder@bots.acme.com');

    expect(h.order).toEqual([
      'timeout',
      'gate:exclusive',
      'update:pr_file_approvals',
      'update:change_requests',
      'update:change_requests',
      'update:pr_merge_log',
      'update:pending_commits',
      'update:pr_file_approvals',
      'update:change_requests',
      'update:pr_merge_log',
      'update:pending_commits',
    ]);
    expect(h.locked).toEqual([[4207, 0]]);
    expect(h.lockSql[0]).toContain('pg_advisory_xact_lock');
    // The new address, canonical, in the address and its index; nothing else
    // (the bot's name is unchanged by a domain change).
    expect(h.sets).toEqual([
      { approverEmail: 'coder@bots.acme.com', approverEmailBidx: 'coder@bots.acme.com' },
      { authorEmail: 'coder@bots.acme.com', authorEmailBidx: 'coder@bots.acme.com' },
      { applyFailedByEmailBidx: 'coder@bots.acme.com' },
      { triggeredByEmail: 'coder@bots.acme.com', triggeredByEmailBidx: 'coder@bots.acme.com' },
      { authorEmail: 'coder@bots.acme.com', authorEmailBidx: 'coder@bots.acme.com' },
      ...Array(4).fill({ madeByEmail: 'coder@bots.acme.com', madeByEmailBidx: 'coder@bots.acme.com' }),
    ]);
    // Matched by the blind index of the old address, canonical: the address
    // columns hold randomized ciphertext and would match nothing.
    expect(h.wheres.map((w) => w.sql.replace(/^.*?("[a-z_]+") = \$1$/, '$1'))).toEqual([
      '"approver_email_bidx"',
      '"author_email_bidx"',
      '"apply_failed_by_email_bidx"',
      '"triggered_by_email_bidx"',
      '"author_email_bidx"',
      ...Array(4).fill('"made_by_email_bidx"'),
    ]);
    for (const where of h.wheres) {
      expect(JSON.stringify(where.params)).toContain('coder@agent.hexis');
      expect(JSON.stringify(where.params)).not.toContain('Coder@Agent.Hexis');
    }
  });

  it('moves every address column the schema has, but the two a bot\'s domain change reaches otherwise', async () => {
    // Every blind index of an address in the schema, as table.column.
    const schema = readFileSync(fileURLToPath(new URL('../../../database/core-schema.ts', import.meta.url)), 'utf8');
    const columns = new Set<string>();
    let table = '';
    for (const line of schema.split('\n')) {
      table = /pgTable\('([a-z_]+)'/.exec(line)?.[1] ?? table;
      const column = /blindIndexText\('([a-z_]*email[a-z_]*)'\)/.exec(line)?.[1];
      if (column) columns.add(`${table}.${column}`);
    }
    const h = harness();
    await h.svc.readdressIdentity(h.tx, 'coder@agent.hexis', 'coder@bots.acme.com');
    const tables = h.order.filter((o) => o.startsWith('update:')).map((o) => o.slice('update:'.length));
    const moved = h.wheres.map((w, i) => `${tables[i]}.${w.sql.replace(/^.*?"([a-z_]+)" = \$1$/, '$1')}`);
    const reachedOtherwise = [
      // The bot's own row: the domain change itself re-addresses it.
      'users.email_bidx',
      // Recorded only through a signed-in session's route; a bot holds no session.
      'plugin_join_requests.requester_email_bidx',
    ];
    expect(new Set([...moved, ...reachedOtherwise])).toEqual(columns);
  });

  it('holdRecordWriters takes the same lock, exclusively, and touches no row', async () => {
    const h = harness();
    await h.svc.holdRecordWriters(h.tx);
    expect(h.order).toEqual(['timeout', 'gate:exclusive']);
    expect(h.locked).toEqual([[4207, 0]]);
  });

  it('touches nothing and takes no lock when the address does not change', async () => {
    const h = harness();
    await h.svc.readdressIdentity(h.tx, 'coder@agent.hexis', 'Coder@agent.hexis');
    expect(h.order).toEqual([]);
  });
});
