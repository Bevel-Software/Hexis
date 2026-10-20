import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { eq, sql } from 'drizzle-orm';
import { closeDb, createDb, type Database } from '../connection.js';
import { changeRequests, dataMigrations } from '../core-schema.js';
import { LEGACY_REQUEST_BODIES_MOVED, moveLegacyRequestBodies, runCoreMigrations, runPiiEncryptionBackfill } from '../migrate.js';
import { coreMigrationsDir } from '../../../assets.js';
import { IndexOnWrite, SealOnWrite } from '../../../shared/column-crypto.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';

/**
 * The data half of migration 0020, on a real Postgres: a deployment whose
 * bodies still carry the generated owners block and an access request's
 * level and note starts on this release, and comes out with the level and
 * the note on their columns and the prose alone in the body. Pinned through
 * the one entry point a start uses, `runCoreMigrations`, so the test fails if
 * the pass is ever not wired to the start that applies 0020 — and shows that
 * the next start writes nothing.
 *
 * Runs where `TEST_DATABASE_URL` names a server this role may create
 * databases on, each test in a scratch database of its own.
 */
const KEY = randomBytes(32).toString('base64');
const open: Database[] = [];
const folders: string[] = [];

const GENERATED = ['## Affected owners', '', '- `Docs/a.md` — Admin', '- `Docs/b.md` — Jane <jane@x.io>'].join('\n');

const ACCESS_REQUEST_BODY = [
  '<!--hexis:access-request-level:owner-->',
  'Rita \\(rita@x\\.io\\) asked for **Owner** on Research\\.',
  '',
  'Note from Rita:',
  '',
  '<!--hexis:access-request-note-->',
  '> I maintain these pages now',
  '<!--/hexis:access-request-note-->',
  '',
  "Anyone who can edit this folder's access answers it.",
  '',
  GENERATED,
].join('\n');

/** The core history as it stood BEFORE 0020: the packaged folder minus 0020 and its ledger table (0021), in a folder of this test's own. */
function historyBefore0020(): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'hexis-core-before-0020-'));
  folders.push(folder);
  cpSync(coreMigrationsDir(), folder, { recursive: true });
  rmSync(path.join(folder, '0020_change_request_body_is_the_description.sql'));
  rmSync(path.join(folder, 'meta', '0020_snapshot.json'));
  rmSync(path.join(folder, '0021_data_migrations_ledger.sql'));
  rmSync(path.join(folder, 'meta', '0021_snapshot.json'));
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx < 20);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return folder;
}

async function handle(): Promise<Database> {
  const db = createDb(await scratchDatabaseUrl('hexis_legacy_bodies'), { piiKey: KEY });
  open.push(db);
  return db;
}

/**
 * A database an older version left: started on the history to 0019 (so its
 * personal-data backfill has run and sealed columns are trusted as sealed),
 * holding the rows that version wrote — sealed as it sealed them, through SQL
 * that names only the columns that existed then (the schema module already
 * knows the two new ones).
 */
async function olderDeployment(): Promise<Database> {
  const db = await handle();
  // As that version's start did it: its SQL history, then its PII backfill.
  await migrate(db, { migrationsFolder: historyBefore0020(), migrationsTable: '__drizzle_migrations_core' });
  await runPiiEncryptionBackfill(db);
  // Sealed by the handle's own connection, as every write through it is —
  // the marks the column codecs hand it — so what the pass reads back is
  // exactly what the older version wrote.
  const seal = (plain: string) => new SealOnWrite(plain) as unknown as string;
  const index = (plain: string) => new IndexOnWrite(plain) as unknown as string;
  const row = (branch: string, title: string, body: string, email: string, name: string, state = 'open') =>
    sql`(${branch}, 'main', ${seal(title)}, ${seal(body)}, ${seal(email)}, ${index(email)}, ${seal(name)}, ${state})`;
  await db.execute(sql`
    insert into change_requests (source_branch, target_branch, title, body, author_email, author_email_bidx, author_name, state) values
      ${row('ada/draft', 'Ordinary', `Please take a look.\n\n## Why now\n\nBecause.\n\n${GENERATED}`, 'ada@example.com', 'Ada')},
      ${row('rita/join-research', 'Access request: Research', ACCESS_REQUEST_BODY, 'rita@x.io', 'Rita')},
      ${row('bo/clean', 'Already clean', 'P2 - Planned\n\nJust prose.', 'bo@example.com', 'Bo', 'merged')}
  `);
  return db;
}

const ledgerRows = async (db: Database) =>
  (await db.select({ name: dataMigrations.name, note: dataMigrations.note }).from(dataMigrations)).map((r) => ({ name: r.name, note: r.note }));

const rowsOf = async (db: Database) =>
  (await db.select().from(changeRequests).orderBy(changeRequests.sourceBranch)).map((r) => ({
    branch: r.sourceBranch,
    body: r.body,
    level: r.accessRequestLevel,
    note: r.accessRequestNote,
    updatedAt: r.updatedAt,
  }));

describe.skipIf(!PG_ADMIN_URL)('migration 0020 — a request body becomes its description', () => {
  afterAll(async () => {
    for (const db of open) await closeDb(db);
    await dropScratchDatabases();
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  }, PG_TEST_TIMEOUT);

  it(
    'the start that applies it moves the level and the note onto the columns and leaves the prose, open and closed rows alike',
    async () => {
      const db = await olderDeployment();
      await runCoreMigrations(db, coreMigrationsDir());

      expect(await rowsOf(db)).toEqual([
        { branch: 'ada/draft', body: 'Please take a look.\n\n## Why now\n\nBecause.', level: null, note: null, updatedAt: null },
        { branch: 'bo/clean', body: 'P2 - Planned\n\nJust prose.', level: null, note: null, updatedAt: null },
        {
          branch: 'rita/join-research',
          body: [
            'Rita \\(rita@x\\.io\\) asked for **Owner** on Research\\.',
            '',
            'Note from Rita:',
            '',
            '> I maintain these pages now',
            '',
            "Anyone who can edit this folder's access answers it.",
          ].join('\n'),
          level: 'owner',
          note: 'I maintain these pages now',
          updatedAt: null,
        },
      ]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'the next start writes nothing: the pass belongs to the start that applied 0020',
    async () => {
      const db = await olderDeployment();
      await runCoreMigrations(db, coreMigrationsDir());
      // A body written AFTER the release that happens to use the old words is
      // the author's own, and a second start must not cut it.
      await db
        .update(changeRequests)
        .set({ body: 'Lead.\n\n## Affected owners\n\nI mean the GTM ones.' })
        .where(eq(changeRequests.sourceBranch, 'bo/clean'));

      await runCoreMigrations(db, coreMigrationsDir());

      const bo = (await rowsOf(db)).find((r) => r.branch === 'bo/clean');
      expect(bo?.body).toBe('Lead.\n\n## Affected owners\n\nI mean the GTM ones.');
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a start that died between the SQL history and the pass is finished by the next start',
    async () => {
      // The SQL history applied (drizzle's ledger has 0020 and 0021) but no
      // `data_migrations` row: exactly what a crash in between leaves behind.
      const db = await olderDeployment();
      await migrate(db, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core' });
      expect(await ledgerRows(db)).toEqual([]);

      await runCoreMigrations(db, coreMigrationsDir());

      const rita = (await rowsOf(db)).find((r) => r.branch === 'rita/join-research');
      expect(rita).toMatchObject({ level: 'owner', note: 'I maintain these pages now' });
      expect(rita?.body).not.toContain('<!--');
      expect(await ledgerRows(db)).toEqual([
        { name: LEGACY_REQUEST_BODIES_MOVED, note: '2 of 3 change-request bodies moved to the description-only shape' },
      ]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a pass that fails midway leaves no body moved and no ledger row, and the next start does the whole of it',
    async () => {
      const db = await olderDeployment();
      await migrate(db, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core' });
      // The second body the pass rewrites (in id order) is refused, after the
      // first one was written.
      await db.execute(sql`
        create function refuse_rita() returns trigger language plpgsql as $refuse$
        begin raise exception 'the start died here'; end $refuse$
      `);
      await db.execute(sql`
        create trigger refuse_rita before update on change_requests
        for each row when (old.source_branch = 'rita/join-research') execute function refuse_rita()
      `);
      const before = await rowsOf(db);

      await expect(moveLegacyRequestBodies(db)).rejects.toThrow();
      expect(await rowsOf(db)).toEqual(before);
      expect(await ledgerRows(db)).toEqual([]);

      await db.execute(sql`drop trigger refuse_rita on change_requests`);
      await runCoreMigrations(db, coreMigrationsDir());
      const rows = await rowsOf(db);
      expect(rows.find((r) => r.branch === 'ada/draft')?.body).toBe('Please take a look.\n\n## Why now\n\nBecause.');
      expect(rows.find((r) => r.branch === 'rita/join-research')).toMatchObject({ level: 'owner', note: 'I maintain these pages now' });
      expect((await ledgerRows(db)).map((r) => r.name)).toEqual([LEGACY_REQUEST_BODIES_MOVED]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'the pass records itself with the rows it moves, and a recorded pass reads nothing',
    async () => {
      const db = await olderDeployment();
      await migrate(db, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core' });
      expect(await moveLegacyRequestBodies(db)).toBe(2);
      expect(await moveLegacyRequestBodies(db)).toBe(-1);
      expect((await ledgerRows(db)).map((r) => r.name)).toEqual([LEGACY_REQUEST_BODIES_MOVED]);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a fresh database has nothing to move, and records that too',
    async () => {
      const db = await handle();
      await runCoreMigrations(db, coreMigrationsDir());
      expect(await ledgerRows(db)).toEqual([
        { name: LEGACY_REQUEST_BODIES_MOVED, note: '0 of 0 change-request bodies moved to the description-only shape' },
      ]);
      expect(await moveLegacyRequestBodies(db)).toBe(-1);
    },
    PG_TEST_TIMEOUT,
  );
});
