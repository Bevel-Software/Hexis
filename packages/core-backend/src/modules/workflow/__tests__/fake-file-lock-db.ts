/**
 * An in-memory stand-in for the `file_locks` table, good enough to run the
 * real `FileLockService` against.
 *
 * The question these tests ask is "how many lock rows does this produce, and
 * which one does a caller find" — which a spy that only records arguments
 * cannot answer, because the answer lives in the primary key. So this fake
 * keeps actual rows behind the composite key `(workspace_id, branch, path)`
 * and honours the one PostgreSQL behaviour the service leans on: an
 * `INSERT ... ON CONFLICT DO UPDATE` whose `setWhere` does not match returns
 * NOTHING rather than raising, which is how a live lock reads as contended.
 *
 * WHERE clauses are turned into predicates through drizzle's own
 * `PgDialect.sqlToQuery`, the same public entry point the driver uses to
 * render SQL, rather than by reaching into the condition object's internals.
 * The rendered text is a stable, documented artifact; the internal chunk
 * shapes are neither.
 */

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../../database/connection.js';

export interface LockRow {
  workspaceId: string;
  branch: string;
  path: string;
  holderUserId: string;
  holderName: string;
  mode: string;
  acquiredAt: Date;
  lastHeartbeatAt: Date;
  expiresAt: Date;
}

/** Rendered column name to the row field drizzle maps it onto. */
const FIELD_FOR_COLUMN: Record<string, keyof LockRow> = {
  workspace_id: 'workspaceId',
  branch: 'branch',
  path: 'path',
  holder_user_id: 'holderUserId',
  holder_name: 'holderName',
  mode: 'mode',
  acquired_at: 'acquiredAt',
  last_heartbeat_at: 'lastHeartbeatAt',
  expires_at: 'expiresAt',
};

const COMPARISONS: Record<string, (a: string, b: string) => boolean> = {
  '=': (a, b) => a === b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};

/**
 * Both sides of a comparison as strings. Timestamp parameters come back from
 * `sqlToQuery` already rendered as ISO-8601, and ISO-8601 in a fixed zone
 * sorts chronologically, so a plain string compare gives the same answer the
 * database would.
 */
function comparable(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const dialect = new PgDialect();
const TERM = /"file_locks"\."(\w+)"\s*(<=|>=|=|<|>)\s*\$(\d+)/g;

function predicateFor(condition: SQL | undefined): (row: LockRow) => boolean {
  if (!condition) return () => true;
  const { sql: text, params } = dialect.sqlToQuery(condition);
  const terms = [...text.matchAll(TERM)].map(([, column, operator, index]) => {
    const field = FIELD_FOR_COLUMN[column];
    // A column the regex matched but FIELD_FOR_COLUMN does not know would
    // read `row[undefined]` as the string "undefined" and compare it against
    // a real parameter — excluding every row, silently, which reads in a test
    // exactly like "no lock is held". Fail closed here too, for the same
    // reason the unmatched-reference check below fails closed.
    if (!field) {
      throw new Error(`fake file_locks db has no field mapped for column "${column}": ${text}`);
    }
    return { field, operator, value: comparable(params[Number(index) - 1]) };
  });
  // Every clause the lock service builds is a conjunction of column
  // comparisons. A term this cannot read would silently widen the match, so
  // say so instead of quietly answering the wrong question.
  const rendered = text.replace(TERM, '');
  if (/"file_locks"/.test(rendered)) {
    throw new Error(`fake file_locks db cannot read this WHERE clause: ${text}`);
  }
  return (row) =>
    terms.every(({ field, operator, value }) =>
      COMPARISONS[operator](comparable(row[field]), value),
    );
}

function keyOf(row: Pick<LockRow, 'workspaceId' | 'branch' | 'path'>): string {
  return JSON.stringify([row.workspaceId, row.branch, row.path]);
}

export interface FakeLockDb {
  db: Database;
  /** Every row currently stored, in insertion order. */
  rows: () => LockRow[];
}

export function makeFakeLockDb(): FakeLockDb {
  const store = new Map<string, LockRow>();

  const insert = () => ({
    values: (row: LockRow) => {
      // `null` is the absorbed conflict: a row is already there and the
      // `setWhere` refused it, so the statement writes nothing and RETURNING
      // comes back empty.
      let pending: LockRow | null = { ...row };
      const chain = {
        onConflictDoUpdate: ({
          set,
          setWhere,
        }: {
          set: Partial<LockRow>;
          setWhere?: SQL;
        }) => {
          const existing = store.get(keyOf(row));
          if (existing) {
            pending = predicateFor(setWhere)(existing) ? { ...existing, ...set } : null;
          }
          return chain;
        },
        returning: async (): Promise<LockRow[]> => {
          if (pending === null) return [];
          store.set(keyOf(pending), pending);
          return [{ ...pending }];
        },
      };
      return chain;
    },
  });

  const select = () => ({
    from: () => {
      let matches: LockRow[] = [];
      const chain = {
        where: (condition?: SQL) => {
          matches = [...store.values()].filter(predicateFor(condition));
          return chain;
        },
        limit: async (n: number): Promise<LockRow[]> => matches.slice(0, n).map((r) => ({ ...r })),
        then: (onF: (v: LockRow[]) => unknown, onR?: (e: unknown) => unknown) =>
          Promise.resolve(matches.map((r) => ({ ...r }))).then(onF, onR),
      };
      return chain;
    },
  });

  const update = () => ({
    set: (patch: Partial<LockRow>) => {
      let updated: LockRow[] = [];
      const chain = {
        where: (condition?: SQL) => {
          const match = predicateFor(condition);
          updated = [];
          for (const [key, row] of store) {
            if (!match(row)) continue;
            const next = { ...row, ...patch };
            store.set(key, next);
            updated.push(next);
          }
          return chain;
        },
        returning: async (): Promise<LockRow[]> => updated.map((r) => ({ ...r })),
      };
      return chain;
    },
  });

  const del = () => ({
    where: async (condition?: SQL): Promise<void> => {
      const match = predicateFor(condition);
      for (const [key, row] of [...store]) if (match(row)) store.delete(key);
    },
  });

  const db = { insert, select, update, delete: del } as unknown as Database;
  return { db, rows: () => [...store.values()].map((r) => ({ ...r })) };
}
