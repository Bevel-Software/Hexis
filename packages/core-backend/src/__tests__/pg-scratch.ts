import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * The one fixture for tests that cross a real Postgres. They run where
 * `TEST_DATABASE_URL` names a server this role may create databases on (CI
 * carries one as a service container) and are skipped elsewhere
 * (`describe.skipIf(!PG_ADMIN_URL)`). Each test works in a scratch database
 * of its own, made by {@link scratchDatabaseUrl} and dropped by
 * {@link dropScratchDatabases}; the database the URL names is only connected
 * to, never written.
 */
export const PG_ADMIN_URL = process.env.TEST_DATABASE_URL;

/** Long enough for migrations, and for dropping every scratch database one after another. */
export const PG_TEST_TIMEOUT = 120_000;

const created: string[] = [];

/** Run `fn` on a connection to the admin URL, closed afterwards. */
export async function withPgAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
  const admin = new pg.Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh database for this test, named with `prefix`; its URL. */
export async function scratchDatabaseUrl(prefix: string): Promise<string> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  await withPgAdmin((admin) => admin.query(`create database ${name}`));
  created.push(name);
  const url = new URL(PG_ADMIN_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Drop every scratch database this file made; for `afterAll`, with {@link PG_TEST_TIMEOUT}. */
export async function dropScratchDatabases(): Promise<void> {
  const names = created.splice(0);
  if (names.length === 0) return;
  await withPgAdmin(async (admin) => {
    for (const name of names) await admin.query(`drop database if exists ${name} with (force)`);
  });
}
