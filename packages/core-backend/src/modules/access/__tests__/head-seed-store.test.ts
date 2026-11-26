import { describe, it, expect } from 'vitest';
import { Param } from 'drizzle-orm';

import type { Database } from '../../database/index.js';
import { DbHeadSeedStore } from '../head-seed-store.js';

/** Every value a drizzle condition binds, in order: for `eq(column, value)`, that value. */
function boundValues(node: unknown, depth = 0): unknown[] {
  if (depth > 8 || node === null || node === undefined) return [];
  if (node instanceof Param) return [node.value];
  if (Array.isArray(node)) return node.flatMap((c) => boundValues(c, depth + 1));
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap((c) => boundValues(c, depth + 1)) : [];
}

/**
 * A `Database` double holding the one table the store uses, answering the
 * two statements it makes: the read of its row and the upsert. The read's
 * `where` IS evaluated: only rows whose key the condition binds come back,
 * so a store that read without its key, or with another, is caught.
 */
function oneTable(): { db: Database; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: async (n: number) => {
            const keys = boundValues(condition);
            return [...rows.values()].filter((r) => keys.includes(r.key)).slice(0, n);
          },
        }),
      }),
    }),
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
  const BUILD = { reading: 1, sha: '1'.repeat(40) };

  it('gives back the seed it saved, and keeps one row however often it saves', async () => {
    const { db, rows } = oneTable();
    const store = new DbHeadSeedStore(db, BUILD);
    expect(await store.load()).toBeNull();
    await store.save(seed);
    await store.save({ ...seed, commit: 'c'.repeat(40) });
    expect(rows.size).toBe(1);
    expect(await store.load()).toEqual({ commit: 'c'.repeat(40), declaring: seed.declaring });
  });

  it('reads its own row and no other', async () => {
    const { db, rows } = oneTable();
    const store = new DbHeadSeedStore(db, BUILD);
    // A row under another key, listed first: never the one read.
    rows.set('other', { key: 'other', version: '1.2.3', commit: 'd'.repeat(40), declaring: [] });
    expect(await store.load()).toBeNull();
    await store.save(seed);
    expect(await store.load()).toEqual(seed);
    expect(rows.get('other')!.commit).toBe('d'.repeat(40));
  });

  // A seed's list leaves out every version it takes to declare nothing: a
  // build that parses a page otherwise (a parser fix, same release number)
  // must read the files again rather than trust that list.
  it('does not read a seed another build wrote', async () => {
    const { db } = oneTable();
    await new DbHeadSeedStore(db, BUILD).save(seed);
    expect(await new DbHeadSeedStore(db, { ...BUILD, sha: '2'.repeat(40) }).load()).toBeNull();
    expect(await new DbHeadSeedStore(db, BUILD).load()).toEqual(seed);
  });

  it('does not read a seed written under another reading of the files', async () => {
    const { db } = oneTable();
    await new DbHeadSeedStore(db, BUILD).save(seed);
    expect(await new DbHeadSeedStore(db, { ...BUILD, reading: 2 }).load()).toBeNull();
    expect(await new DbHeadSeedStore(db, BUILD).load()).toEqual(seed);
  });

  it('a build whose sha is unknown reads no seed and saves none', async () => {
    const { db, rows } = oneTable();
    const unknown = new DbHeadSeedStore(db, { ...BUILD, sha: 'unknown' });
    // Two builds with no sha would share one key: neither may trust the other's list.
    await unknown.save(seed);
    expect(rows.size).toBe(0);
    expect(await unknown.load()).toBeNull();
    // A known build's row is neither read nor replaced by it.
    await new DbHeadSeedStore(db, BUILD).save(seed);
    expect(await unknown.load()).toBeNull();
    await unknown.save({ ...seed, commit: 'c'.repeat(40) });
    expect(await new DbHeadSeedStore(db, BUILD).load()).toEqual(seed);
  });

  it('does not read a row whose list is not paths and object ids', async () => {
    const { db, rows } = oneTable();
    const store = new DbHeadSeedStore(db, BUILD);
    await store.save(seed);
    rows.get('latest')!.declaring = [['Team/Own.md']];
    expect(await store.load()).toBeNull();
    rows.get('latest')!.declaring = 'Team/Own.md';
    expect(await store.load()).toBeNull();
  });
});
