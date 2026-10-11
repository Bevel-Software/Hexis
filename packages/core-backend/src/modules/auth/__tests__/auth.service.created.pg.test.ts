import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { runCoreMigrations } from '../../database/migrate.js';
import { coreMigrationsDir } from '../../../assets.js';
import { AuthService } from '../auth.service.js';

/**
 * Whether an account is NEW is answered by the upsert's own returned row,
 * through Postgres's `xmax = 0` (see `CREATED` in auth.service.ts): zero on
 * a row the statement inserted, set on one its `ON CONFLICT DO UPDATE`
 * touched. No stub can stand in for that, so this crosses a real Postgres:
 * the invite's notification hangs on the answer, and a wrong one would
 * either tell nobody or tell the same person twice.
 *
 * Runs where `TEST_DATABASE_URL` names a server this role may create
 * databases on (CI carries one as a service container); skipped elsewhere.
 * The test works in a scratch database of its own and drops it.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
const TIMEOUT = 120_000;
const KEY = randomBytes(32).toString('base64');

const created: string[] = [];
const open: Database[] = [];

async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function scratchDatabase(): Promise<Database> {
  const name = `hexis_created_${randomBytes(6).toString('hex')}`;
  await withAdmin((admin) => admin.query(`create database ${name}`));
  created.push(name);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const db = createDb(url.toString(), { piiKey: KEY });
  open.push(db);
  await runCoreMigrations(db, coreMigrationsDir());
  return db;
}

describe.skipIf(!ADMIN_URL)('whether an account is new, on a real Postgres', () => {
  afterAll(async () => {
    for (const db of open) await closeDb(db);
    await withAdmin(async (admin) => {
      for (const name of created) await admin.query(`drop database if exists ${name} with (force)`);
    });
  });

  it(
    'says created once per address: the insert, and never the conflict-update after it',
    async () => {
      const db = await scratchDatabase();
      const auth = new AuthService(db, { jwtSecret: 'test-jwt-secret', adminEmail: '', adminPassword: '', allowedEmailDomains: [] });

      // Without a password: the first write inserts, the second only updates.
      const first = await auth.createAccountWithoutPassword('Lena@Acme.test', 'Lena');
      expect(first.created).toBe(true);
      expect(first.user).toMatchObject({ email: 'lena@acme.test', name: 'Lena' });
      const again = await auth.createAccountWithoutPassword('lena@acme.test', 'Lena Park');
      expect(again.created).toBe(false);
      expect(again.user).toMatchObject({ id: first.user.id, name: 'Lena Park' });

      // With a starting password: a new address is created with it...
      const tom = await auth.createAccountWithStartingPassword('tom@acme.test', 'welcome-to-acme');
      expect(tom).toMatchObject({ created: true, passwordSet: true, deactivated: false });
      // ...an account that has a password keeps it, and is not new...
      const tomAgain = await auth.createAccountWithStartingPassword('tom@acme.test', 'another-password');
      expect(tomAgain).toMatchObject({ created: false, passwordSet: false, deactivated: false });
      expect(tomAgain.user.id).toBe(tom.user.id);
      // ...and an existing account with none gets it, through the conflict
      // update: a password was set, and the account is still not new.
      const lenaPassword = await auth.createAccountWithStartingPassword('lena@acme.test', 'welcome-to-acme');
      expect(lenaPassword).toMatchObject({ created: false, passwordSet: true, deactivated: false });
      expect(lenaPassword.user.id).toBe(first.user.id);

      // What the rows say agrees: two accounts, both with a password now.
      const accounts = await auth.listAccounts();
      expect(accounts.map((a) => [a.email, a.hasPassword]).sort()).toEqual([
        ['lena@acme.test', true],
        ['tom@acme.test', true],
      ]);
    },
    TIMEOUT,
  );
});
