import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import type { Database } from '../../database/index.js';
import { DbHeadSeedStore } from '../head-seed-store.js';

/**
 * The seed store against a real Postgres at the migrated schema: the table
 * migration `0024` makes, the upsert on its key, and the list kept as JSON
 * and read back as the pairs it was. A double cannot say whether the
 * migration and the statements agree, so this crosses the real ones (see
 * `pg-scratch.ts`).
 */
describe.skipIf(!PG_ADMIN_URL)('DbHeadSeedStore, on a real Postgres', () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await openMigratedScratchDb('hexis_head_seed'));
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    await close?.();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  const rowCount = async (): Promise<number> => {
    const result = await db.execute(sql`select count(*)::int as n from access_head_seeds`);
    return (result.rows[0] as { n: number }).n;
  };

  it(
    'saves, reads back, replaces its one row, and is not read by another build',
    async () => {
      const store = new DbHeadSeedStore(db, { reading: 1, sha: '1'.repeat(40) });
      expect(await store.load()).toBeNull();

      // Paths as a knowledge base has them: spaces, a quote, non-ASCII.
      const first = {
        commit: 'a'.repeat(40),
        declaring: [
          ['Team/Own.md', 'b'.repeat(40)],
          ['Équipe/Fiche "une".md', 'c'.repeat(40)],
        ] as Array<[string, string]>,
      };
      await store.save(first);
      expect(await store.load()).toEqual(first);
      expect(await rowCount()).toBe(1);

      // A later save replaces the row: the upsert on the key, not a second row.
      const second = { commit: 'd'.repeat(40), declaring: [] as Array<[string, string]> };
      await store.save(second);
      expect(await store.load()).toEqual(second);
      expect(await rowCount()).toBe(1);

      // Another build reads nothing, and its save takes the row over.
      const next = new DbHeadSeedStore(db, { reading: 1, sha: '2'.repeat(40) });
      expect(await next.load()).toBeNull();
      await next.save(first);
      expect(await next.load()).toEqual(first);
      expect(await store.load()).toBeNull();
      expect(await rowCount()).toBe(1);
    },
    PG_TEST_TIMEOUT,
  );
});
