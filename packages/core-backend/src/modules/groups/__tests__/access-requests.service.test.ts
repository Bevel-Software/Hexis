import { describe, it, expect, beforeEach, vi } from 'vitest';
import { groupAccessRequests } from '../../database/core-schema.js';
import { AccessRequestsService } from '../access-requests.service.js';
import type { Database } from '../../database/connection.js';

/**
 * Faithful in-memory fake of the slice of the Drizzle `Database` this service
 * uses against `group_access_requests`, including the PARTIAL unique index
 * (`status = 'pending'`) that makes `create` idempotent — `onConflictDoNothing`
 * only no-ops because that index exists, so the fake enforces it rather than
 * assuming it.
 *
 * A live-Postgres integration test (real partial index, real RETURNING race)
 * is still owed once the repo grows a Postgres test harness — same debt the
 * session-ontology service test carries.
 */
interface Row {
  id: string;
  groupName: string;
  requesterEmail: string;
  requesterName: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByEmail: string | null;
}

/** Drizzle column object → row key, so predicates can name real columns. */
const COLUMN_KEYS = new Map<unknown, keyof Row>([
  [groupAccessRequests.id, 'id'],
  [groupAccessRequests.groupName, 'groupName'],
  [groupAccessRequests.requesterEmail, 'requesterEmail'],
  [groupAccessRequests.requesterName, 'requesterName'],
  [groupAccessRequests.status, 'status'],
  [groupAccessRequests.createdAt, 'createdAt'],
]);

type Pred =
  | { op: 'eq'; col: unknown; val: unknown }
  | { op: 'in'; col: unknown; vals: unknown[] }
  | { op: 'and'; parts: Pred[] };

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    inArray: (col: unknown, vals: unknown[]) => ({ op: 'in', col, vals }),
    and: (...parts: Pred[]) => ({ op: 'and', parts }),
    asc: (col: unknown) => ({ op: 'asc', col }),
  };
});

function matches(row: Row, pred: Pred): boolean {
  if (pred.op === 'and') return pred.parts.every((p) => matches(row, p));
  const key = COLUMN_KEYS.get(pred.col)!;
  if (pred.op === 'in') return pred.vals.includes(row[key]);
  return row[key] === pred.val;
}

function makeFakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const project = (row: Row, cols: Record<string, unknown> | undefined) => {
    if (!cols) return { ...row };
    return Object.fromEntries(
      Object.entries(cols).map(([alias, col]) => [alias, row[COLUMN_KEYS.get(col)!]]),
    );
  };
  const db = {
    _rows: rows,
    insert() {
      return {
        values(v: { groupName: string; requesterEmail: string; requesterName: string }) {
          return {
            onConflictDoNothing() {
              // The partial unique index: at most ONE pending row per pair.
              const clash = rows.some(
                (r) =>
                  r.status === 'pending' &&
                  r.groupName === v.groupName &&
                  r.requesterEmail === v.requesterEmail,
              );
              if (!clash) {
                rows.push({
                  id: `req-${++seq}`,
                  groupName: v.groupName,
                  requesterEmail: v.requesterEmail,
                  requesterName: v.requesterName,
                  status: 'pending',
                  createdAt: new Date(Date.now() + seq),
                  resolvedAt: null,
                  resolvedByEmail: null,
                });
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    select(cols?: Record<string, unknown>) {
      return {
        from() {
          const where = (pred: Pred) => {
            const hits = rows.filter((r) => matches(r, pred));
            const sorted = () =>
              [...hits]
                .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
                .map((r) => project(r, cols));
            const result = {
              // Thenable rather than async, so `.orderBy(...)` can be awaited
              // directly OR chained into `.limit(n)` — the real builder allows
              // both and `pendingAll` uses the chained form.
              orderBy: () => ({
                limit: async (n: number) => sorted().slice(0, n),
                then: (resolve: (v: unknown[]) => void) => resolve(sorted()),
              }),
              limit: async (n: number) => hits.slice(0, n).map((r) => project(r, cols)),
              then: (resolve: (v: unknown[]) => void) => resolve(hits.map((r) => project(r, cols))),
            };
            return result;
          };
          return { where };
        },
      };
    },
    update() {
      return {
        set(patch: Partial<Row>) {
          return {
            where(pred: Pred) {
              const hits = rows.filter((r) => matches(r, pred));
              for (const r of hits) Object.assign(r, patch);
              return {
                returning: async () => hits.map((r) => ({ id: r.id })),
                then: (resolve: (v: unknown[]) => void) => resolve([]),
              };
            },
          };
        },
      };
    },
  };
  return db;
}

describe('AccessRequestsService', () => {
  let db: ReturnType<typeof makeFakeDb>;
  let svc: AccessRequestsService;

  beforeEach(() => {
    db = makeFakeDb();
    svc = new AccessRequestsService(db as unknown as Database);
  });

  it('create is idempotent per (group, requester) while pending', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    expect(db._rows).toHaveLength(1);
    expect(await svc.pendingByRequester('ali@bevel.software')).toEqual([
      { id: 'req-1', groupName: 'Finance' },
    ]);
  });

  it('create lowercases the requester email', async () => {
    await svc.create('Finance', 'Ali@Bevel.Software', 'Ali Baba');
    expect(db._rows[0].requesterEmail).toBe('ali@bevel.software');
    // …and the lookup lowercases too, so a differently-cased session still matches.
    expect(await svc.pendingByRequester('ALI@bevel.software')).toHaveLength(1);
  });

  it('lets a requester ask again once an earlier row is settled', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.markFulfilled(['req-1']);
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    expect(db._rows).toHaveLength(2);
    expect(await svc.pendingByRequester('ali@bevel.software')).toEqual([
      { id: 'req-2', groupName: 'Finance' },
    ]);
  });

  it('pendingAll lists every pending row oldest first', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.create('GTM', 'juan@bevel.software', 'Juan Viera');
    const all = await svc.pendingAll();
    expect(all.map((r) => r.groupName)).toEqual(['Finance', 'GTM']);
    expect(all[0]).toMatchObject({ requesterName: 'Ali Baba', requesterEmail: 'ali@bevel.software' });
  });

  it('pendingAll caps the scan, keeping the OLDEST rows', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.create('GTM', 'juan@bevel.software', 'Juan Viera');
    await svc.create('Engineering', 'olga@bevel.software', 'Olga Ivanova');

    // Oldest-first is what makes the cap safe to drop rows at: the ones it
    // sheds are the newest, which the next load still finds.
    expect((await svc.pendingAll(2)).map((r) => r.groupName)).toEqual(['Finance', 'GTM']);
  });

  it('markFulfilled retires rows and pendingAll excludes them', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.markFulfilled(['req-1']);
    expect(db._rows[0]).toMatchObject({ status: 'fulfilled', resolvedByEmail: null });
    expect(db._rows[0].resolvedAt).toBeInstanceOf(Date);
    expect(await svc.pendingAll()).toEqual([]);
    expect(await svc.getPending('req-1')).toBeNull();
  });

  it('markFulfilled with no ids touches nothing', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    await svc.markFulfilled([]);
    expect(db._rows[0].status).toBe('pending');
  });

  it('dismiss flips only pending rows and stamps resolvedByEmail/resolvedAt', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    expect(await svc.dismiss('req-1', 'Olga@bevel.software')).toBe(true);
    expect(db._rows[0]).toMatchObject({ status: 'dismissed', resolvedByEmail: 'olga@bevel.software' });
    // A second dismiss (or a dismiss racing a fulfillment) changes nothing.
    expect(await svc.dismiss('req-1', 'olga@bevel.software')).toBe(false);
    expect(await svc.dismiss('no-such-row', 'olga@bevel.software')).toBe(false);
  });

  it('getPending returns the row while pending and null once settled', async () => {
    await svc.create('Finance', 'ali@bevel.software', 'Ali Baba');
    expect(await svc.getPending('req-1')).toMatchObject({
      id: 'req-1',
      groupName: 'Finance',
      requesterEmail: 'ali@bevel.software',
    });
    await svc.dismiss('req-1', 'olga@bevel.software');
    expect(await svc.getPending('req-1')).toBeNull();
  });
});
