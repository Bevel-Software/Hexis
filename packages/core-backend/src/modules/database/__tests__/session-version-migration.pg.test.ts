import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, type Database } from '../connection.js';
import { runCoreMigrations, runPiiEncryptionBackfill } from '../migrate.js';
import { coreMigrationsDir } from '../../../assets.js';
import { IndexOnWrite, SealOnWrite } from '../../../shared/column-crypto.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';

/**
 * Migration 0022 on a real Postgres, from both states a deployment can be in
 * when it starts on this release: without `users.session_version` (every
 * account starts at 0, so nobody is signed out by the upgrade), and with the
 * column already there (the guarded `ADD COLUMN` changes nothing, so the
 * generations it holds, and the sessions they honour, survive the start).
 *
 * Runs where `TEST_DATABASE_URL` names a server this role may create
 * databases on, each test in a scratch database of its own.
 */
const KEY = randomBytes(32).toString('base64');
const open: Database[] = [];
const folders: string[] = [];

/** The core history as it stood BEFORE 0022: the packaged folder minus 0022, in a folder of this test's own. */
function historyBefore0022(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'hexis-core-before-0022-'));
  folders.push(folder);
  cpSync(coreMigrationsDir(), folder, { recursive: true });
  rmSync(path.join(folder, '0022_session_version.sql'));
  rmSync(path.join(folder, 'meta', '0022_snapshot.json'));
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < 22);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

/**
 * A database an older version left: started on the history to 0021, holding
 * the accounts that version wrote, through SQL that names only the columns
 * it knew. `withColumn` adds `session_version` by hand first, as a database
 * that already has it would, and gives each account a generation of its own.
 */
async function olderDeployment(withColumn: boolean): Promise<Database> {
  const db = createDb(await scratchDatabaseUrl('hexis_session_version'), { piiKey: KEY });
  open.push(db);
  await migrate(db, { migrationsFolder: historyBefore0022(), migrationsTable: '__drizzle_migrations_core' });
  await runPiiEncryptionBackfill(db);
  if (withColumn) await db.execute(sql`alter table users add column session_version integer default 0 not null`);
  const seal = (plain: string) => new SealOnWrite(plain) as unknown as string;
  const index = (plain: string) => new IndexOnWrite(plain) as unknown as string;
  const account = (email: string, name: string) => sql`(${seal(email)}, ${index(email)}, ${seal(name)})`;
  await db.execute(sql`
    insert into users (email, email_bidx, name) values
      ${account('ada@example.com', 'Ada')},
      ${account('bo@example.com', 'Bo')}
  `);
  if (withColumn) {
    await db.execute(sql`update users set session_version = 3 where email_bidx = ${index('ada@example.com')}`);
    await db.execute(sql`update users set session_version = 7 where email_bidx = ${index('bo@example.com')}`);
  }
  return db;
}

/** Each account's generation, in a fixed order. */
const generations = async (db: Database) =>
  (await db.execute(sql`select session_version from users order by session_version`)).rows.map(
    (r) => (r as { session_version: number }).session_version,
  );

/** What the column is: its type, default and nullability, as Postgres reports them. */
const columnShape = async (db: Database) =>
  (
    await db.execute(sql`
      select data_type, column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'session_version'
    `)
  ).rows;

const EXPECTED_SHAPE = [{ data_type: 'integer', column_default: '0', is_nullable: 'NO' }];

describe.skipIf(!PG_ADMIN_URL)('migration 0022 (users.session_version), on a real Postgres', () => {
  afterAll(async () => {
    for (const db of open.splice(0)) await closeDb(db);
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    'adds the column at 0 for every existing account, so no session is ended by the upgrade',
    async () => {
      const db = await olderDeployment(false);
      expect(await columnShape(db)).toEqual([]);

      await runCoreMigrations(db, coreMigrationsDir());

      expect(await columnShape(db)).toEqual(EXPECTED_SHAPE);
      expect(await generations(db)).toEqual([0, 0]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'finds the column already there and changes nothing, keeping every generation it holds',
    async () => {
      const db = await olderDeployment(true);
      expect(await columnShape(db)).toEqual(EXPECTED_SHAPE);

      await runCoreMigrations(db, coreMigrationsDir());

      expect(await columnShape(db)).toEqual(EXPECTED_SHAPE);
      expect(await generations(db)).toEqual([3, 7]);
      // And 0022 is recorded as applied, so the next start does not try it again.
      // Found by its own ledger row (drizzle records each migration under its
      // journal `when`), not by a count: a later migration must not break this.
      const journal = JSON.parse(readFileSync(path.join(coreMigrationsDir(), 'meta', '_journal.json'), 'utf-8')) as {
        entries: Array<{ tag: string; when: number }>;
      };
      const entry = journal.entries.find((e) => e.tag.startsWith('0022_'));
      expect(entry?.tag).toBe('0022_session_version');
      const applied = await db.execute(
        sql`select count(*)::int as n from drizzle.__drizzle_migrations_core where created_at = ${entry!.when}`,
      );
      expect((applied.rows[0] as { n: number }).n).toBe(1);
    },
    PG_TEST_TIMEOUT,
  );
});
