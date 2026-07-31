import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SessionOntologyService } from '../session-ontology.service.js';
import type { Database } from '../../database/connection.js';

const PRODUCT = 'KnowledgeBase/Product';
const PLATFORM = 'KnowledgeBase/Platform';
const P_READ = 'KnowledgeBase/Product/Knowledge/Foo.md';
const PL_READ = 'KnowledgeBase/Platform/Knowledge/Bar.md';

/**
 * Faithful in-memory fake of the slice of the Drizzle `Database` the service
 * uses against the `session_ontology_touches` table (one row per
 * `(session_id, ontology)`):
 *  - `insert().onConflictDoNothing()` adds a row unless the PK pair exists.
 *  - `select({ontology}).from().where(eq(session))` returns the session's rows.
 *  - `delete().where(eq(session) | lt(touchedAt, cutoff))` removes rows.
 *
 * A live-Postgres integration test (real PK conflict, real `touched_at < now()`
 * sweep) is still owed once the repo grows a Postgres test harness (tasks 3.4).
 */
interface Row {
  sessionId: string;
  ontology: string;
  touchedAt: Date;
}

function makeFakeDb() {
  const rows: Row[] = [];
  const db = {
    _rows: rows,
    insert() {
      return {
        values(v: { sessionId: string; ontology: string }) {
          return {
            onConflictDoNothing() {
              const exists = rows.some((r) => r.sessionId === v.sessionId && r.ontology === v.ontology);
              if (!exists) rows.push({ sessionId: v.sessionId, ontology: v.ontology, touchedAt: new Date() });
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            async where(pred: { sessionId: string }) {
              return rows
                .filter((r) => r.sessionId === pred.sessionId)
                .map((r) => ({ ontology: r.ontology }));
            },
          };
        },
      };
    },
    delete() {
      return {
        where(pred: { sessionId?: string; cutoff?: Date }) {
          if (pred.sessionId !== undefined) {
            for (let i = rows.length - 1; i >= 0; i--) {
              if (rows[i].sessionId === pred.sessionId) rows.splice(i, 1);
            }
            return { async returning() { return []; } } as never;
          }
          const removed: { sessionId: string }[] = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            if (pred.cutoff && rows[i].touchedAt < pred.cutoff) {
              removed.push({ sessionId: rows[i].sessionId });
              rows.splice(i, 1);
            }
          }
          return { async returning() { return removed; } } as never;
        },
      };
    },
  };
  return db;
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (_col: unknown, val: string) => ({ sessionId: val }),
    lt: (_col: unknown, val: Date) => ({ cutoff: val }),
  };
});

function makeService() {
  const db = makeFakeDb();
  return { svc: new SessionOntologyService(db as unknown as Database), db };
}

describe('SessionOntologyService (touched-set model)', () => {
  let svc: SessionOntologyService;
  let db: ReturnType<typeof makeFakeDb>;

  beforeEach(() => {
    ({ svc, db } = makeService());
  });

  it('records a read and allows it', async () => {
    const d = await svc.checkOperation('s1', P_READ, false);
    expect(d.allow).toBe(true);
    expect(await svc.getTouched('s1')).toEqual([PRODUCT]);
  });

  it('allows reads ACROSS ontologies (reads are never blocked)', async () => {
    expect((await svc.checkOperation('s1', P_READ, false)).allow).toBe(true);
    expect((await svc.checkOperation('s1', PL_READ, false)).allow).toBe(true);
    expect(await svc.getTouched('s1')).toEqual([PLATFORM, PRODUCT]);
  });

  it('allows a write while the session is confined to that one ontology', async () => {
    await svc.checkOperation('s1', P_READ, false);
    expect((await svc.checkOperation('s1', P_READ, true)).allow).toBe(true);
  });

  it('allows the first write with no prior reads and pins to it', async () => {
    expect((await svc.checkOperation('s1', P_READ, true)).allow).toBe(true);
    expect(await svc.getTouched('s1')).toEqual([PRODUCT]);
  });

  it('blocks a write to a different ontology than the one read (different-ontology)', async () => {
    // Load-bearing for the start_session↔ask unification: the touched-set is
    // keyed purely by sessionId, so a READ and a later WRITE that share ONE id
    // hit the same set and cross-ontology writes are refused. This only protects
    // the read→ask flow because both now run under the SAME id (start_session
    // mints a real chat thread; ask accepts it). If a refactor re-splits those
    // namespaces, the read and the ask write land in different touched-sets and
    // this guarantee silently evaporates — see workspace.tools.ts start_session.
    await svc.checkOperation('s1', P_READ, false);
    const d = await svc.checkOperation('s1', PL_READ, true);
    expect(d).toMatchObject({ allow: false, reason: 'different-ontology', attempted: PLATFORM });
    // The blocked write does NOT record Platform.
    expect(await svc.getTouched('s1')).toEqual([PRODUCT]);
  });

  it('blocks ALL writes once the session has read across two ontologies (multi-ontology)', async () => {
    await svc.checkOperation('s1', P_READ, false);
    await svc.checkOperation('s1', PL_READ, false); // reads across — poisons writes
    // Even a write back into Product is now blocked.
    const back = await svc.checkOperation('s1', P_READ, true);
    expect(back).toMatchObject({ allow: false, reason: 'multi-ontology' });
    const other = await svc.checkOperation('s1', PL_READ, true);
    expect(other.allow).toBe(false);
  });

  it('treats a neutral path as always-allowed and never recorded', async () => {
    const d = await svc.checkOperation('s1', 'access.md', true);
    expect(d.allow).toBe(true);
    expect(await svc.getTouched('s1')).toEqual([]);
  });

  it('survives a "restart": a new instance re-reads the touched set from the store', async () => {
    await svc.checkOperation('s1', P_READ, false);
    await svc.checkOperation('s1', PL_READ, false);
    const afterRestart = new SessionOntologyService(db as unknown as Database);
    // The poison persists across the restart: writes still blocked.
    expect((await afterRestart.checkOperation('s1', P_READ, true)).allow).toBe(false);
  });

  it('reclaims a session on delete so it can write again', async () => {
    await svc.checkOperation('s1', P_READ, false);
    await svc.checkOperation('s1', PL_READ, false);
    await svc.delete('s1');
    expect(await svc.getTouched('s1')).toEqual([]);
    expect((await svc.checkOperation('s1', P_READ, true)).allow).toBe(true);
  });

  it('sweeps abandoned sessions older than the cutoff', async () => {
    await svc.checkOperation('old', P_READ, false);
    db._rows.forEach((r) => { if (r.sessionId === 'old') r.touchedAt = new Date(Date.now() - 60_000); });
    const removed = await svc.sweepOlderThan(new Date(Date.now() - 30_000));
    expect(removed).toBe(1);
    expect(await svc.getTouched('old')).toEqual([]);
  });

  it('records each ontology only once (idempotent touches)', async () => {
    await svc.checkOperation('s1', P_READ, false);
    await svc.checkOperation('s1', P_READ, false);
    await svc.checkOperation('s1', P_READ, false);
    expect(db._rows.filter((r) => r.sessionId === 's1').length).toBe(1);
  });

  it('serializes two concurrent same-session writes to different ontologies (only one wins)', async () => {
    // Without per-session serialization both could observe an empty touched set
    // and both pin to a different ontology before either INSERT lands.
    const [a, b] = await Promise.all([
      svc.checkOperation('s1', P_READ, true), // write → Product
      svc.checkOperation('s1', PL_READ, true), // write → Platform (concurrent)
    ]);
    // Exactly one write is allowed; the loser is blocked as different-ontology.
    expect([a, b].filter((d) => d.allow)).toHaveLength(1);
    // Only the winner's ontology is recorded.
    expect(await svc.getTouched('s1')).toHaveLength(1);
  });
});
