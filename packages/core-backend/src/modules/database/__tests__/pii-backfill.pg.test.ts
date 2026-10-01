import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { eq, inArray, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, createDb, type Database } from '../connection.js';
import { runCoreMigrations } from '../migrate.js';
import { prFileApprovals, users } from '../core-schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { derivePiiKeys, isEncryptedBlob } from '../../../shared/column-crypto.js';

/**
 * Personal data in a real Postgres: what a database handle stores under its
 * key, and the backfill that seals what an older version left in clear. The
 * backfill rewrites every personal-data row of a deployment once, with no
 * second chance, and deletes rows on the way (the duplicate collapse) — so
 * what it does is pinned here through the one entry point a start uses,
 * `runCoreMigrations`, and read back over a plain connection that holds no
 * key, which sees what a dump would.
 *
 * Runs where `TEST_DATABASE_URL` names a server this role may create
 * databases on (CI carries one as a service container); skipped elsewhere.
 * Every test works in a scratch database of its own and drops it: the
 * database the URL names is only connected to, never written.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const TIMEOUT = 120_000;
const KEY = randomBytes(32).toString('base64');
const keys = derivePiiKeys(KEY);

const TABLES = [
  'users',
  'pr_file_approvals',
  'pr_merge_log',
  'pr_comments',
  'change_requests',
  'pending_commits',
  'file_locks',
  'plugin_join_requests',
] as const;

type Row = Record<string, unknown>;
type Query = (text: string) => Promise<Row[]>;

const created: string[] = [];
const open: Database[] = [];
const plain: pg.Pool[] = [];

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** A scratch database of this test's own; dropped in `afterAll`. */
async function scratchDatabase(): Promise<string> {
  const name = `hexis_pii_${randomBytes(6).toString('hex')}`;
  await withAdmin((admin) => admin.query(`create database ${name}`));
  created.push(name);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** The application's handle on a schema, holding `key`. */
function handle(url: string, opts: { schema?: string; key?: string | null } = {}): Database {
  const piiKey = opts.key === null ? undefined : (opts.key ?? KEY);
  const db = createDb(url, { ...(opts.schema ? { schema: opts.schema } : {}), ...(piiKey ? { piiKey } : {}) });
  open.push(db);
  return db;
}

/** What is STORED, read over a connection that holds no key — as a dump would show it. */
function stored(url: string, schema?: string): Query {
  const pool = new pg.Pool({ connectionString: url, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
  plain.push(pool);
  return async (text) => (await pool.query(text)).rows as Row[];
}

/**
 * A schema as an upgrade finds it: the SQL history applied — migration
 * 0014's nullable blind-index columns included — and nothing sealed yet. That
 * is the state between the history and the backfill, and the one rows of an
 * older version can be planted in.
 */
async function beforeTheBackfill(
  url: string,
  opts: { schema?: string; key?: string } = {},
): Promise<{ db: Database; q: Query }> {
  const db = handle(url, opts);
  if (opts.schema) await db.execute(sql.raw(`create schema if not exists "${opts.schema}"`));
  await migrate(db, {
    migrationsFolder: coreMigrationsDir(),
    migrationsTable: '__drizzle_migrations_core',
    migrationsSchema: opts.schema,
  });
  return { db, q: stored(url, opts.schema) };
}

/** Rows as an older version wrote them: plaintext, no blind index. */
async function plantLegacyRows(q: Query): Promise<void> {
  await q(`insert into users (email, name, avatar_url) values
    ('Ada@Example.com', 'Ada', null),
    ('bo@example.com', 'Bo', 'https://img.example.com/bo.png')`);
  await q(`insert into change_requests
      (source_branch, target_branch, title, author_email, author_name, apply_failure_reason, apply_failed_by_name, apply_failed_at)
    values ('d', 'main', 'A title', 'ada@example.com', 'Ada', 'bo@example.com is not an approver', 'Bo', now())`);
  await q(`insert into pr_merge_log (pr_number, triggered_by_email, triggered_by_name, head_sha_at_merge, merge_method, succeeded, error)
    values (1, 'ada@example.com', 'Ada', 'abc', 'merge', true, null),
           (1, 'bo@example.com', 'Bo', 'abc', 'merge', false, 'Bo has no push right')`);
  await q(`insert into pr_comments (pr_number, author_email, author_name, head_sha, body)
    values (1, 'bo@example.com', 'Bo', 'abc', 'Looks right to me')`);
  await q(`insert into pending_commits (workspace_id, branch, path, author_email, author_name, last_error)
    values ('w', 'main', 'a.md', 'ada@example.com', 'Ada', 'rejected for Ada')`);
  await q(`insert into file_locks (workspace_id, branch, path, holder_user_id, holder_name, expires_at)
    select 'w', 'main', 'a.md', id, 'Ada', now() + interval '1 hour' from users where email = 'Ada@Example.com'`);
  // One person's approval and join request, twice, under two spellings of
  // the address: distinct rows to the old unique index, one row to the new.
  await q(`insert into pr_file_approvals (pr_number, path, approver_email, approver_name, head_sha, approved_at)
    values (1, 'a.md', 'ada@example.com', 'Ada', 'abc', now() - interval '2 hours'),
           (1, 'a.md', 'ADA@example.com', 'Ada later', 'abc', now() - interval '1 hour')`);
  await q(`insert into plugin_join_requests (requester_email, requester_name, plugin_key, failure_reason, created_at)
    values ('ada@example.com', 'Ada', 'gtm', 'git refused Ada', now() - interval '2 hours'),
           ('Ada@example.com', 'Ada later', 'gtm', null, now() - interval '1 hour')`);
}

/** Every row of every table the backfill touches, as stored. */
async function everything(q: Query): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const table of TABLES) {
    out[table] = (await q(`select to_jsonb(t) as row from "${table}" t order by to_jsonb(t)::text`)).map((r) => r.row);
  }
  return JSON.stringify(out);
}

/** {@link everything} with the blobs masked: random base64 spells a planted name by chance often enough. */
const everythingReadable = async (q: Query) => (await everything(q)).replace(/"pii:v1:[^"]*"/g, '"sealed"');

const opened = (value: unknown) => keys.read(String(value));
const sealed = (value: unknown) => typeof value === 'string' && isEncryptedBlob(value);

describe.skipIf(!ADMIN_URL)('personal data, on a real Postgres', () => {
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => closeDb(db)));
    await Promise.all(plain.splice(0).map((pool) => pool.end()));
  });

  afterAll(async () => {
    await withAdmin(async (admin) => {
      for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
    });
  });

  describe('what a handle stores', () => {
    it(
      'seals and indexes what the application writes, and reads it back, a transaction included',
      async () => {
        const url = await scratchDatabase();
        const db = handle(url);
        const q = stored(url);
        await runCoreMigrations(db, coreMigrationsDir());

        await db.insert(users).values({ email: 'Ada@Example.com', emailBidx: 'Ada@Example.com', name: 'Ada' });
        await db.transaction(async (tx) => {
          await tx.insert(users).values({ email: 'bo@example.com', emailBidx: 'bo@example.com', name: 'Bo', avatarUrl: '' });
          // Inside the transaction the handle's key is the one at work too.
          const [bo] = await tx.select().from(users).where(eq(users.emailBidx, ' BO@example.com'));
          expect(bo).toMatchObject({ email: 'bo@example.com', name: 'Bo', avatarUrl: '' });
        });

        const rows = await q(`select email, email_bidx, name, avatar_url from users order by created_at`);
        expect(rows.every((r) => sealed(r.email) && sealed(r.name))).toBe(true);
        expect(rows.map((r) => r.email_bidx)).toEqual([keys.index('ada@example.com'), keys.index('bo@example.com')]);
        // NULL stays NULL and the empty string stays itself.
        expect(rows.map((r) => r.avatar_url)).toEqual([null, '']);

        const found = await db.select().from(users).where(inArray(users.emailBidx, ['ADA@example.com', 'nobody@x.co']));
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ email: 'Ada@Example.com', name: 'Ada', avatarUrl: null });

        await db.update(users).set({ name: 'Ada L.' }).where(eq(users.emailBidx, 'ada@example.com'));
        const [renamed] = await q(`select name from users where email_bidx = '${keys.index('ada@example.com')}'`);
        expect(sealed(renamed!.name)).toBe(true);
        expect(opened(renamed!.name)).toBe('Ada L.');

        // A copied row carries the address its index is made from; the stored
        // index read back beside it is refused as a value to write.
        await db.insert(prFileApprovals).values({
          prNumber: 1, path: 'a.md', approverEmail: 'ada@example.com', approverEmailBidx: 'ada@example.com', approverName: 'Ada', headSha: 'abc',
        });
        const [approval] = await db.select().from(prFileApprovals);
        expect(approval!.approverEmailBidx).toBe(keys.index('ada@example.com'));
        await expect(async () => {
          await db.insert(prFileApprovals).values({ ...approval!, id: undefined, headSha: 'def' });
        }).rejects.toThrow(/stored index/);

        // Raw SQL through the handle reads plaintext as well; the stored form
        // is there for whoever asks for the bytes.
        const [viaSql] = (
          await db.execute(sql`select email, convert_to(email, 'UTF8') as kept from users where email_bidx = ${keys.index('bo@example.com')}`)
        ).rows as Array<{ email: string; kept: Buffer }>;
        expect(viaSql!.email).toBe('bo@example.com');
        expect(sealed(viaSql!.kept.toString('utf8'))).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'a handle that holds no key writes no personal data, and is refused a start',
      async () => {
        const url = await scratchDatabase();
        await runCoreMigrations(handle(url), coreMigrationsDir());
        const keyless = handle(url, { key: null });
        const q = stored(url);

        // drizzle reports the statement that failed; the reason is its cause.
        const refused = { cause: { message: expect.stringMatching(/holds no key/) } };
        await expect(
          keyless.insert(users).values({ email: 'ada@example.com', emailBidx: 'ada@example.com', name: 'Ada' }),
        ).rejects.toMatchObject(refused);
        await expect(
          keyless.select().from(users).where(eq(users.emailBidx, 'ada@example.com')),
        ).rejects.toMatchObject(refused);
        expect(await q(`select 1 from users`)).toHaveLength(0);
        await expect(runCoreMigrations(keyless, coreMigrationsDir())).rejects.toThrow(/holds no personal-data key/);
      },
      TIMEOUT,
    );

    it(
      'two knowledge bases in one database are sealed under their own keys',
      async () => {
        const url = await scratchDatabase();
        const acmeKey = randomBytes(32).toString('base64');
        const zetaKey = randomBytes(32).toString('base64');
        const acme = handle(url, { schema: 't_acme', key: acmeKey });
        const zeta = handle(url, { schema: 't_zeta', key: zetaKey });
        for (const [db, schema] of [[acme, 't_acme'], [zeta, 't_zeta']] as const) {
          await db.execute(sql.raw(`create schema if not exists "${schema}"`));
          await runCoreMigrations(db, coreMigrationsDir());
          await db.insert(users).values({ email: 'ada@example.com', emailBidx: 'ada@example.com', name: `Ada of ${schema}` });
        }

        // The same address, a different index in each: knowing one tenant's
        // says nothing about the other's.
        const q = stored(url);
        const [a] = await q(`select email, email_bidx from t_acme.users`);
        const [z] = await q(`select email, email_bidx from t_zeta.users`);
        expect(a!.email_bidx).toBe(derivePiiKeys(acmeKey).index('ada@example.com'));
        expect(z!.email_bidx).toBe(derivePiiKeys(zetaKey).index('ada@example.com'));
        expect(a!.email_bidx).not.toBe(z!.email_bidx);

        // Each reads its own, in the same process, at the same time.
        const [[mine], [theirs]] = await Promise.all([
          acme.select().from(users).where(eq(users.emailBidx, 'ada@example.com')),
          zeta.select().from(users).where(eq(users.emailBidx, 'ada@example.com')),
        ]);
        expect(mine!.name).toBe('Ada of t_acme');
        expect(theirs!.name).toBe('Ada of t_zeta');

        // And neither opens the other's, even handed the row.
        const [crossed] = (await acme.execute(sql`select name from t_zeta.users`)).rows as Array<{ name: string }>;
        expect(sealed(crossed!.name)).toBe(true);
        // A tenant's dump opens with the tenant's key alone.
        expect(derivePiiKeys(zetaKey).read(String(z!.email))).toBe('ada@example.com');
      },
      TIMEOUT,
    );
  });

  describe('the backfill at start', () => {
    it(
      'seals what an older version wrote, indexes it, and moves the unique constraints',
      async () => {
        const { db, q } = await beforeTheBackfill(await scratchDatabase());
        await plantLegacyRows(q);

        await runCoreMigrations(db, coreMigrationsDir());

        // users: ciphertext with the spelling kept, the index over the canonical
        // address, and a NULL left a NULL.
        const people = await q(`select email, email_bidx, name, avatar_url from users`);
        expect(people.every((u) => sealed(u.email) && sealed(u.name))).toBe(true);
        const ada = people.find((u) => opened(u.email) === 'Ada@Example.com')!;
        const bo = people.find((u) => opened(u.email) === 'bo@example.com')!;
        expect(ada.email_bidx).toBe(keys.index('ada@example.com'));
        expect(ada.avatar_url).toBeNull();
        expect(opened(bo.avatar_url)).toBe('https://img.example.com/bo.png');
        expect(sealed(bo.avatar_url)).toBe(true);

        // change_requests: the text, the author, the recorded refusal; the
        // body the database defaulted to '' stays ''.
        const [cr] = await q(`select * from change_requests`);
        expect([cr!.title, cr!.author_email, cr!.author_name, cr!.apply_failure_reason, cr!.apply_failed_by_name].every(sealed)).toBe(true);
        expect(cr!.body).toBe('');
        expect(opened(cr!.apply_failure_reason)).toBe('bo@example.com is not an approver');
        expect(cr!.author_email_bidx).toBe(keys.index('ada@example.com'));

        const log = await q(`select * from pr_merge_log`);
        expect(log.every((r) => sealed(r.triggered_by_email) && sealed(r.triggered_by_name))).toBe(true);
        expect(log.map((r) => (r.error === null ? null : opened(r.error))).sort()).toEqual(['Bo has no push right', null]);
        expect(log.every((r) => r.error === null || sealed(r.error))).toBe(true);
        expect(log.every((r) => r.triggered_by_email_bidx === keys.index(opened(r.triggered_by_email)))).toBe(true);

        const [comment] = await q(`select * from pr_comments`);
        expect([comment!.author_email, comment!.author_name, comment!.body].every(sealed)).toBe(true);
        expect(comment!.author_email_bidx).toBe(keys.index('bo@example.com'));

        const [queued] = await q(`select * from pending_commits`);
        expect([queued!.author_email, queued!.author_name, queued!.last_error].every(sealed)).toBe(true);
        expect(queued!.author_email_bidx).toBe(keys.index('ada@example.com'));

        const [lock] = await q(`select * from file_locks`);
        expect(sealed(lock!.holder_name)).toBe(true);
        expect(opened(lock!.holder_name)).toBe('Ada');

        // The two spellings were one person's: the earliest row of each stays.
        const approvals = await q(`select * from pr_file_approvals`);
        expect(approvals).toHaveLength(1);
        expect(opened(approvals[0]!.approver_name)).toBe('Ada');
        expect(approvals[0]!.approver_email_bidx).toBe(keys.index('ada@example.com'));
        const requests = await q(`select * from plugin_join_requests`);
        expect(requests).toHaveLength(1);
        expect(opened(requests[0]!.requester_name)).toBe('Ada');
        expect(opened(requests[0]!.failure_reason)).toBe('git refused Ada');
        expect(requests[0]!.requester_email_bidx).toBe(keys.index('ada@example.com'));

        // Nothing a dump would show names anyone.
        expect(await everythingReadable(q)).not.toMatch(/example\.com|Ada|Bo /);

        // Uniqueness moved from the raw columns to the blind indexes.
        const indexes = (await q(`select indexname from pg_indexes where schemaname = current_schema()`)).map(
          (r) => r.indexname,
        );
        expect(indexes).toEqual(
          expect.arrayContaining([
            'users_email_bidx_unq',
            'pr_file_approvals_bidx_unq',
            'plugin_join_requests_requester_bidx_plugin_unq',
          ]),
        );
        expect(indexes).not.toContain('users_email_unique');
        expect(indexes).not.toContain('pr_file_approvals_unq');
        expect(indexes).not.toContain('plugin_join_requests_requester_plugin_unq');
        await expect(
          q(`insert into users (email, email_bidx, name) values ('x', '${keys.index('ADA@example.com')}', 'x')`),
        ).rejects.toThrow();
        await expect(q(`insert into users (email, name) values ('x', 'x')`)).rejects.toThrow();

        // And the application reads it back as it was written.
        const [read] = await db.select().from(users).where(eq(users.emailBidx, 'ADA@EXAMPLE.COM '));
        expect(read).toMatchObject({ email: 'Ada@Example.com', name: 'Ada', avatarUrl: null });
      },
      TIMEOUT,
    );

    it(
      'writes nothing on a second start',
      async () => {
        const { db, q } = await beforeTheBackfill(await scratchDatabase());
        await plantLegacyRows(q);
        await runCoreMigrations(db, coreMigrationsDir());
        const after = await everything(q);

        await runCoreMigrations(db, coreMigrationsDir());

        expect(await everything(q)).toBe(after);
      },
      TIMEOUT,
    );

    it(
      'stops the start on two accounts with one address, names both, and writes nothing',
      async () => {
        const { db, q } = await beforeTheBackfill(await scratchDatabase());
        await plantLegacyRows(q);
        await q(`insert into users (email, name) values ('BO@example.com', 'Bo too')`);
        const before = await everything(q);
        const ids = (await q(`select id from users where lower(email) = 'bo@example.com'`)).map((r) => String(r.id));

        const refusal = await runCoreMigrations(db, coreMigrationsDir()).then(
          () => '',
          (err: Error) => err.message,
        );

        expect(refusal).toMatch(/share the same email/);
        for (const id of ids) expect(refusal).toContain(id);
        // One transaction: the rows already rewritten when the conflict was
        // found are rolled back with it, the duplicate collapse included.
        expect(await everything(q)).toBe(before);
      },
      TIMEOUT,
    );

    it(
      'refuses a start under a key that does not open what is sealed, and changes nothing',
      async () => {
        const url = await scratchDatabase();
        const { db, q } = await beforeTheBackfill(url);
        await plantLegacyRows(q);
        await runCoreMigrations(db, coreMigrationsDir());
        const after = await everything(q);

        const rekeyed = handle(url, { key: randomBytes(32).toString('base64') });
        await expect(runCoreMigrations(rekeyed, coreMigrationsDir())).rejects.toThrow(/does not open/);
        expect(await everything(q)).toBe(after);

        await expect(runCoreMigrations(db, coreMigrationsDir())).resolves.toBeUndefined();
      },
      TIMEOUT,
    );

    it(
      'recomputes the index of an address an older writer replaced in clear',
      async () => {
        const { db, q } = await beforeTheBackfill(await scratchDatabase());
        await plantLegacyRows(q);
        await runCoreMigrations(db, coreMigrationsDir());
        // A version from before the upgrade, still running, renames the account:
        // it knows nothing of the index beside the column.
        await q(`update users set email = 'Bo.New@Example.com' where email_bidx = '${keys.index('bo@example.com')}'`);

        await runCoreMigrations(db, coreMigrationsDir());

        const [row] = await q(`select email, email_bidx from users where email_bidx = '${keys.index('bo.new@example.com')}'`);
        expect(sealed(row?.email)).toBe(true);
        expect(opened(row?.email)).toBe('Bo.New@Example.com');
        expect(await q(`select 1 from users where email_bidx = '${keys.index('bo@example.com')}'`)).toHaveLength(0);
      },
      TIMEOUT,
    );

    it(
      "works in a tenant's schema, under the tenant's key, and leaves the default schema alone",
      async () => {
        const url = await scratchDatabase();
        const main = await beforeTheBackfill(url);
        await plantLegacyRows(main.q);
        const untouched = await everything(main.q);
        const tenantKey = randomBytes(32).toString('base64');
        const tenantKeys = derivePiiKeys(tenantKey);
        const tenant = await beforeTheBackfill(url, { schema: 't_acme', key: tenantKey });
        await plantLegacyRows(tenant.q);

        await runCoreMigrations(tenant.db, coreMigrationsDir());

        const people = await tenant.q(`select email, email_bidx from users`);
        expect(people).toHaveLength(2);
        expect(
          people.every((u) => sealed(u.email) && u.email_bidx === tenantKeys.index(tenantKeys.read(String(u.email)))),
        ).toBe(true);
        // Under the tenant's key and no other.
        expect(people.every((u) => !keys.open(String(u.email)).ok)).toBe(true);
        expect(await tenant.q(`select 1 from pr_file_approvals`)).toHaveLength(1);
        expect(await everythingReadable(tenant.q)).not.toMatch(/example\.com/);
        const indexes = (await tenant.q(`select indexname from pg_indexes where schemaname = 't_acme'`)).map((r) => r.indexname);
        expect(indexes).toContain('users_email_bidx_unq');
        expect(indexes).not.toContain('users_email_unique');

        expect(await everything(main.q)).toBe(untouched);
      },
      TIMEOUT,
    );
  });
});
