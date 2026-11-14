import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService } from '../auth.service.js';
import { SessionEndedError } from '../account-admission.js';
import { createAuthRoutes } from '../auth.routes.js';
import { AUTH_COOKIE_NAME, createAuthMiddleware } from '../auth.middleware.js';
import { verifyPassword } from '../password-hash.js';

/**
 * Something to run once, the next time a password is hashed: a change hashes
 * its new password after reading the row and proving the current one, and
 * before writing, so this is where "another session changed it first" lands.
 */
const beforeNextHash = vi.hoisted(() => ({ run: null as null | (() => Promise<void>) }));
vi.mock('../password-hash.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../password-hash.js')>();
  return {
    ...original,
    hashPassword: async (password: string) => {
      const run = beforeNextHash.run;
      beforeNextHash.run = null;
      if (run) await run();
      return original.hashPassword(password);
    },
  };
});

/**
 * Changing your password ends the sessions opened with the old one, and a
 * change whose current password stopped being current is refused. Both are
 * a row's session generation and a conditional write on it, which no stub
 * can stand in for, so this crosses a real Postgres (see `pg-scratch.ts`)
 * through the real routes and the real auth middleware.
 */
const JWT_SECRET = 'test-jwt-secret';

describe.skipIf(!PG_ADMIN_URL)('a password change and the sessions opened before it, on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let auth: AuthService;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_pwchange'));
    auth = new AuthService(db, { jwtSecret: JWT_SECRET, adminEmail: '', adminPassword: '', allowedEmailDomains: [] });
    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRoutes(auth, createAuthMiddleware(auth)));
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server) server.close(() => resolve());
      else resolve();
    });
    if (db) await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  /** A sign-in: its bearer token, and the auth cookie a browser would keep. */
  async function signIn(email: string, password: string): Promise<{ token: string; cookie: string }> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    return { token: ((await res.json()) as { token: string }).token, cookie: authCookie(res) };
  }

  function authCookie(res: Response): string {
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    if (!set) throw new Error('no auth cookie set');
    return set.split(';')[0];
  }

  function changePassword(token: string, currentPassword: string, newPassword: string) {
    return fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
  }

  const meWithBearer = (token: string) =>
    fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
  const meWithCookie = (cookie: string) =>
    fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } }).then((r) => r.status);

  async function storedRow(email: string) {
    const [row] = await db.select().from(users).where(eq(users.emailBidx, email)).limit(1);
    return row;
  }

  it(
    'ends every token and browser session issued before the change, except the one that made it',
    async () => {
      await auth.createAccount('kim@acme.test', 'Kim', 'old-password-1');
      const changer = await signIn('kim@acme.test', 'old-password-1');
      const laptop = await signIn('kim@acme.test', 'old-password-1');
      const browser = await signIn('kim@acme.test', 'old-password-1');
      // All three are live, and the cached answer the middleware now holds
      // is exactly what the change has to get past.
      expect(await meWithBearer(changer.token)).toBe(200);
      expect(await meWithBearer(laptop.token)).toBe(200);
      expect(await meWithCookie(browser.cookie)).toBe(200);

      const res = await changePassword(changer.token, 'old-password-1', 'new-password-1');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; token: string };
      expect(body.ok).toBe(true);

      // Every session opened before the change answers 401 on its next request...
      expect(await meWithBearer(laptop.token)).toBe(401);
      expect(await meWithCookie(browser.cookie)).toBe(401);
      expect(await meWithBearer(browser.token)).toBe(401);
      expect(await meWithCookie(laptop.cookie)).toBe(401);
      // ...the changer's old credentials included: what it carries on with is
      // the fresh token and cookie the change handed back.
      expect(await meWithBearer(changer.token)).toBe(401);
      expect(await meWithCookie(changer.cookie)).toBe(401);
      expect(await meWithBearer(body.token)).toBe(200);
      expect(await meWithCookie(authCookie(res))).toBe(200);

      // The old password signs nobody in; the new one does, and its session lives.
      const old = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'kim@acme.test', password: 'old-password-1' }),
      });
      expect(old.status).toBe(401);
      const again = await signIn('kim@acme.test', 'new-password-1');
      expect(await meWithBearer(again.token)).toBe(200);
      // ...and so does the changer's, alongside it.
      expect(await meWithBearer(body.token)).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'refuses, in words, a change whose current password another session changed first, and writes nothing',
    async () => {
      await auth.createAccount('lena@acme.test', 'Lena', 'old-password-1');
      const first = await signIn('lena@acme.test', 'old-password-1');
      const second = await signIn('lena@acme.test', 'old-password-1');

      // The second session's change has read the row and proven the old
      // password when the first session's change lands.
      let firstStatus = 0;
      beforeNextHash.run = async () => {
        firstStatus = (await changePassword(first.token, 'old-password-1', 'first-new-password')).status;
      };
      const raced = await changePassword(second.token, 'old-password-1', 'second-new-password');
      expect(firstStatus).toBe(200);
      expect(raced.status).toBe(409);
      expect(((await raced.json()) as { error: string }).error).toMatch(
        /changed from another session.*nothing was changed/,
      );

      // Nothing of the refused change was written: the first change's
      // password is the account's, and the generation moved on once.
      const afterRace = await storedRow('lena@acme.test');
      expect(await verifyPassword('first-new-password', afterRace.passwordHash!)).toBe(true);
      expect(await verifyPassword('second-new-password', afterRace.passwordHash!)).toBe(false);
      expect(afterRace.sessionVersion).toBe(1);

      // A session opened since, typing the password that is no longer
      // current, is refused in words and changes nothing either.
      const third = await signIn('lena@acme.test', 'first-new-password');
      const stale = await changePassword(third.token, 'old-password-1', 'third-new-password');
      expect(stale.status).toBe(400);
      expect(((await stale.json()) as { error: string }).error).toBe('Current password is incorrect');
      const afterStale = await storedRow('lena@acme.test');
      expect(afterStale.passwordHash).toBe(afterRace.passwordHash);
      expect(afterStale.sessionVersion).toBe(1);
      expect(await meWithBearer(third.token)).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'ends the sessions opened before an admin reset, and refuses a change that read the row before it',
    async () => {
      await auth.createAccount('noor@acme.test', 'Noor', 'old-password-1');
      const laptop = await signIn('noor@acme.test', 'old-password-1');
      const changer = await signIn('noor@acme.test', 'old-password-1');
      expect(await meWithBearer(laptop.token)).toBe(200);
      expect(await meWithCookie(laptop.cookie)).toBe(200);

      // The reset lands after the self-service change has proven the old password.
      beforeNextHash.run = async () => {
        await auth.createAccount('noor@acme.test', undefined, 'reset-password-1');
      };
      const raced = await changePassword(changer.token, 'old-password-1', 'self-new-password');
      expect(raced.status).toBe(409);

      // The reset is the account's password, and the generation moved on once.
      const row = await storedRow('noor@acme.test');
      expect(await verifyPassword('reset-password-1', row.passwordHash!)).toBe(true);
      expect(row.sessionVersion).toBe(1);
      expect(await meWithBearer(laptop.token)).toBe(401);
      expect(await meWithCookie(laptop.cookie)).toBe(401);
      expect(await meWithBearer(changer.token)).toBe(401);
      const fresh = await signIn('noor@acme.test', 'reset-password-1');
      expect(await meWithBearer(fresh.token)).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'ends the old sessions on another replica at their next request too',
    async () => {
      // A second process on the same database, with its own cache, which has
      // just seen the session live.
      const replica = new AuthService(db, { jwtSecret: JWT_SECRET, adminEmail: '', adminPassword: '', allowedEmailDomains: [] });
      await auth.createAccount('omar@acme.test', 'Omar', 'old-password-1');
      const laptop = await signIn('omar@acme.test', 'old-password-1');
      const changer = await signIn('omar@acme.test', 'old-password-1');
      await expect(replica.resolveSession(laptop.token)).resolves.toMatchObject({ email: 'omar@acme.test' });

      const res = await changePassword(changer.token, 'old-password-1', 'new-password-1');
      expect(res.status).toBe(200);
      const { token } = (await res.json()) as { token: string };

      const ended = replica.resolveSession(laptop.token);
      await expect(ended).rejects.toBeInstanceOf(SessionEndedError);
      await expect(ended).rejects.toThrow(/password was changed after this session was opened/);
      await expect(replica.resolveSession(token)).resolves.toMatchObject({ email: 'omar@acme.test' });
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'refuses a first password set from the Account page when an admin set a starting one meanwhile',
    async () => {
      // Single sign-on only: no password yet, so the Account page asks for no current one.
      const { token: sso } = await auth.loginWithSso('pia@acme.test', 'Pia', { admittedByProvider: true });
      expect(await meWithBearer(sso)).toBe(200);

      beforeNextHash.run = async () => {
        const set = await auth.createAccountWithStartingPassword('pia@acme.test', 'starting-password-1');
        expect(set.passwordSet).toBe(true);
      };
      const raced = await fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sso}` },
        body: JSON.stringify({ newPassword: 'self-new-password' }),
      });
      expect(raced.status).toBe(409);

      const row = await storedRow('pia@acme.test');
      expect(await verifyPassword('starting-password-1', row.passwordHash!)).toBe(true);
      expect(row.sessionVersion).toBe(1);
      expect(await meWithBearer(sso)).toBe(401);
    },
    PG_TEST_TIMEOUT,
  );
});
