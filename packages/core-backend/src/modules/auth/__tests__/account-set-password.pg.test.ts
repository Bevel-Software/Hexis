import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService } from '../auth.service.js';
import { AccountErasureService } from '../account-erasure.service.js';
import { createAccountRoutes } from '../account.routes.js';

/**
 * Something to run once, the next time a password is hashed: setting one
 * reads the account, then hashes, then writes, so this is where another
 * admin's delete lands between the read and the write.
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
 * Set password and Reset password on a row of the User accounts page change
 * that account and never make one. An account another admin deleted while
 * the dialog was open is refused, and its address stays free. Whether a
 * write made an account is the database's answer, so this crosses a real
 * Postgres (see `pg-scratch.ts`) through the real account routes, with the
 * real erasure behind the delete.
 */
describe.skipIf(!PG_ADMIN_URL)('setting a password from an account row, on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let auth: AuthService;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_setpw'));
    auth = new AuthService(db, { jwtSecret: 'test-jwt-secret', adminEmail: '', adminPassword: '', allowedEmailDomains: [] });
    const erasure = new AccountErasureService(db, { eraseApprover: async () => undefined });
    const { user: admin } = await auth.createAccountWithoutPassword('admin@acme.test', 'Admin');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = admin.id;
      req.userEmail = admin.email;
      next();
    });
    app.use(
      '/api',
      createAccountRoutes(auth, { isAdmin: async () => true }, erasure, {
        runAccountInvited: async () => [],
        runAccountDeactivated: async () => [],
      }),
    );
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

  const setPassword = (userId: string, password: string) =>
    fetch(`${base}/api/admin/accounts/${userId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  const deleteAccount = (userId: string) => fetch(`${base}/api/admin/accounts/${userId}`, { method: 'DELETE' });
  const listed = async (email: string) => (await auth.listAccounts()).filter((a) => a.email === email);
  const signsIn = (email: string, password: string) =>
    auth.loginWithPassword(email, password).then(
      () => true,
      () => false,
    );

  it(
    'refuses a reset for an account another admin deleted, and makes no account',
    async () => {
      const kim = await auth.createAccount('kim@acme.test', 'Kim', 'old-password-1');
      // Another admin deletes it while this admin's Reset dialog is open.
      expect((await deleteAccount(kim.id)).status).toBe(204);

      const res = await setPassword(kim.id, 'new-password-1');
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'No such user' });
      // The deletion stands: no account at that address, and nobody signs in with either password.
      expect(await listed('kim@acme.test')).toEqual([]);
      expect(await signsIn('kim@acme.test', 'new-password-1')).toBe(false);
      expect(await signsIn('kim@acme.test', 'old-password-1')).toBe(false);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'refuses it too when the delete lands between reading the account and writing the password',
    async () => {
      const lena = await auth.createAccount('lena@acme.test', 'Lena', 'old-password-1');
      let deleted = 0;
      beforeNextHash.run = async () => {
        deleted = (await deleteAccount(lena.id)).status;
      };

      const res = await setPassword(lena.id, 'new-password-1');
      expect(deleted).toBe(204);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'No such user' });
      expect(await listed('lena@acme.test')).toEqual([]);
      expect(await signsIn('lena@acme.test', 'new-password-1')).toBe(false);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'sets a first password on an account just invited, and resets it, on the same account',
    async () => {
      // An invite without a password, as the Invite dialog sends it.
      const invite = await fetch(`${base}/api/admin/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'noor@acme.test' }),
      });
      expect(invite.status).toBe(201);
      const { id } = (await invite.json()) as { id: string };

      expect((await setPassword(id, 'first-password-1')).status).toBe(204);
      expect(await listed('noor@acme.test')).toMatchObject([{ id, hasPassword: true }]);
      expect(await signsIn('noor@acme.test', 'first-password-1')).toBe(true);

      expect((await setPassword(id, 'second-password-1')).status).toBe(204);
      expect(await listed('noor@acme.test')).toMatchObject([{ id, hasPassword: true }]);
      expect(await signsIn('noor@acme.test', 'second-password-1')).toBe(true);
      expect(await signsIn('noor@acme.test', 'first-password-1')).toBe(false);
    },
    PG_TEST_TIMEOUT,
  );
});
