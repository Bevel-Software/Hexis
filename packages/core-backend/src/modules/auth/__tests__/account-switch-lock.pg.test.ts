import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { runCoreMigrations } from '../../database/migrate.js';
import { coreMigrationsDir } from '../../../assets.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';
import { VersionControlDomainError } from '../../../shared/domain-errors.js';
import { AuthService } from '../auth.service.js';
import { ACCOUNT_BUSY_MESSAGE, takeAccountSwitchLock } from '../account-switch-lock.js';

/**
 * The account switch lock's promise, against a real Postgres (see
 * `pg-scratch.ts`): a wait that runs out is a 409 `account-busy`, never the
 * driver's error. Drizzle wraps that error (the SQLSTATE `55P03` is on its
 * cause), which no stub of the driver shows, so the contention is real here:
 * another connection holds the address's lock while the lock is asked for.
 */
const KEY = randomBytes(32).toString('base64');
const open: Database[] = [];
const holders: pg.Client[] = [];

async function migratedDatabase(): Promise<{ db: Database; url: string }> {
  const url = await scratchDatabaseUrl('hexis_switch');
  const db = createDb(url, { piiKey: KEY });
  open.push(db);
  await runCoreMigrations(db, coreMigrationsDir());
  return { db, url };
}

/** Another connection holding `email`'s switch lock in an open transaction, as a promotion mid-write does. */
async function holdLock(url: string, email: string): Promise<pg.Client> {
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  holders.push(holder);
  await holder.query('begin');
  await holder.query('select pg_advisory_xact_lock(hashtext($1))', [`account-switch:${email}`]);
  return holder;
}

describe.skipIf(!PG_ADMIN_URL)('the account switch lock under contention, on a real Postgres', () => {
  afterAll(async () => {
    for (const holder of holders) await holder.end().catch(() => undefined);
    for (const db of open) await closeDb(db);
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    "answers a wait that runs out as the 409 account-busy, through Drizzle's wrapping",
    async () => {
      const { db, url } = await migratedDatabase();
      const holder = await holdLock(url, 'alice@acme.test');
      const refusal = db.transaction((tx) => takeAccountSwitchLock(tx, 'Alice@Acme.test', 200));
      await expect(refusal).rejects.toBeInstanceOf(VersionControlDomainError);
      await expect(refusal).rejects.toMatchObject({ status: 409, message: ACCOUNT_BUSY_MESSAGE, payload: { kind: 'account-busy' } });
      // Released, the lock is taken at once.
      await holder.query('commit');
      await expect(db.transaction((tx) => takeAccountSwitchLock(tx, 'alice@acme.test', 200))).resolves.toBeUndefined();
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'switching an account off while a promotion holds its lock is refused as account-busy, and changes nothing',
    async () => {
      const { db, url } = await migratedDatabase();
      const auth = new AuthService(db, { jwtSecret: 'test-jwt-secret', adminEmail: '', adminPassword: '', allowedEmailDomains: [] });
      const { user } = await auth.createAccountWithoutPassword('lee@acme.test', 'Lee');
      const holder = await holdLock(url, 'lee@acme.test');
      // The real wait (15 s): what an admin's switch-off meets.
      await expect(auth.deactivate(user.id)).rejects.toMatchObject({ status: 409, payload: { kind: 'account-busy' } });
      await holder.query('commit');
      const [lee] = (await auth.listAccounts()).filter((a) => a.email === 'lee@acme.test');
      expect(lee?.deactivatedAt).toBeNull();
    },
    PG_TEST_TIMEOUT,
  );
});
