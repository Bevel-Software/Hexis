import { describe, it, expect } from 'vitest';

import type { Database } from '../../database/index.js';
import { DbHeadSeedStore } from '../head-seed-store.js';

/**
 * A `Database` double holding the one table the store uses, answering the
 * two statements it makes: the read of its row and the upsert.
 */
function oneTable(): { db: Database; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [...rows.values()] }) }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: async ({ set }: { set: Record<string, unknown> }) => {
          rows.set(String(v.key), { ...v, ...set });
        },
      }),
    }),
  } as unknown as Database;
  return { db, rows };
}

describe('DbHeadSeedStore', () => {
  const seed = { commit: 'a'.repeat(40), declaring: [['Team/Own.md', 'b'.repeat(40)]] as Array<[string, string]> };

  it('gives back the seed it saved, and keeps one row however often it saves', async () => {
    const { db, rows } = oneTable();
    const store = new DbHeadSeedStore(db, '1.2.3');
    expect(await store.load()).toBeNull();
    await store.save(seed);
    await store.save({ ...seed, commit: 'c'.repeat(40) });
    expect(rows.size).toBe(1);
    expect(await store.load()).toEqual({ commit: 'c'.repeat(40), declaring: seed.declaring });
  });

  it('does not read a seed another release wrote', async () => {
    const { db } = oneTable();
    await new DbHeadSeedStore(db, '1.2.3').save(seed);
    expect(await new DbHeadSeedStore(db, '1.2.4').load()).toBeNull();
    expect(await new DbHeadSeedStore(db, '1.2.3').load()).toEqual(seed);
  });

  it('does not read a row whose list is not paths and object ids', async () => {
    const { db, rows } = oneTable();
    const store = new DbHeadSeedStore(db, '1.2.3');
    await store.save(seed);
    rows.get('latest')!.declaring = [['Team/Own.md']];
    expect(await store.load()).toBeNull();
    rows.get('latest')!.declaring = 'Team/Own.md';
    expect(await store.load()).toBeNull();
  });
});
