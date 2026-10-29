import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService } from '../auth.service.js';
import { createInvitationRoutes } from '../invitation.routes.js';
import { admitEveryone, type IAccountAdmission } from '../index.js';

/**
 * An invitation makes a NEW account and writes nothing to one that is
 * there: the insert does nothing on conflict, which no stub can stand in
 * for, so this crosses a real Postgres (see `pg-scratch.ts`) through the
 * route a member's dialog calls.
 */
const closers: (() => Promise<void>)[] = [];

async function startApp(
  opts: { admission?: IAccountAdmission; adminEmail?: string } = {},
): Promise<{ base: string; auth: AuthService; db: Database; close(): void }> {
  const { db, close } = await openMigratedScratchDb('hexis_invite');
  closers.push(close);
  const auth = new AuthService(
    db,
    {
      jwtSecret: 'test-jwt-secret',
      adminEmail: opts.adminEmail ?? '',
      adminPassword: opts.adminEmail ? 'the-environment-password' : '',
      allowedEmailDomains: [],
      loginPasswordEnabled: true,
    },
    opts.admission ?? admitEveryone,
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = 'member-1';
    req.userEmail = 'member@acme.test';
    next();
  });
  app.use(
    '/api',
    createInvitationRoutes(auth, { isAdmin: async () => false }, { runAccountInvited: async () => [] }, { passwordSignIn: true, providers: [] }),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, auth, db, close: () => server.close() };
}

function invite(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!PG_ADMIN_URL)('invitations on a real Postgres', () => {
  afterAll(async () => {
    for (const close of closers) await close();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it(
    "a member's invite makes a Member account whose generated password signs in",
    async () => {
      const app = await startApp();
      try {
        const res = await invite(app.base, { email: 'New@Acme.test' });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { status: string; account: { email: string }; startingPassword: string };
        expect(body.status).toBe('created');
        expect(body.account.email).toBe('new@acme.test');
        const signedIn = await app.auth.loginWithPassword('new@acme.test', body.startingPassword);
        expect(signedIn.user.email).toBe('new@acme.test');
        // Stored as a hash only.
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'new@acme.test'));
        expect(row!.passwordHash).toMatch(/^scrypt:/);
        expect(row!.passwordHash).not.toContain(body.startingPassword);
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    "a member's invite of an existing address writes nothing and learns only that it exists",
    async () => {
      const app = await startApp();
      try {
        // One with a password, switched off; one without a password at all.
        const withPassword = await app.auth.createAccount('old@acme.test', 'Old Timer', 'their-own-password');
        await app.auth.deactivate(withPassword.id);
        await app.auth.createAccountWithoutPassword('sso@acme.test', 'Sso Person');
        const before = await app.db.select().from(users).orderBy(users.email);

        for (const email of ['old@acme.test', 'OLD@acme.test', 'sso@acme.test']) {
          const res = await invite(app.base, { email });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ status: 'existing' });
        }
        expect(await app.db.select().from(users).orderBy(users.email)).toEqual(before);
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    "never stores a hash for the deployment admin's address: that account signs in with the environment's password",
    async () => {
      const app = await startApp({ adminEmail: 'owner@acme.test' });
      try {
        const res = await invite(app.base, { email: 'owner@acme.test' });
        expect(res.status).toBe(201);
        expect(await res.json()).not.toHaveProperty('startingPassword');
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'owner@acme.test'));
        expect(row!.passwordHash).toBeNull();
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'asks the admission port with the reason invite, for a new address only',
    async () => {
      const canProvision = vi.fn<IAccountAdmission['canProvision']>(async () => ({ ok: false, message: 'No seat left' }));
      const app = await startApp({ admission: { canProvision } });
      try {
        const res = await invite(app.base, { email: 'new@acme.test' });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'No seat left', kind: 'admission' });
        expect(canProvision).toHaveBeenCalledWith('new@acme.test', 'invite');
        expect(await app.db.select().from(users)).toEqual([]);

        // A port with no seat left is not asked about an address that
        // already has an account: that address learns only `existing`.
        await app.db.insert(users).values({ email: 'old@acme.test', emailBidx: 'old@acme.test', name: 'old' });
        canProvision.mockClear();
        const existing = await invite(app.base, { email: 'old@acme.test' });
        expect(existing.status).toBe(200);
        expect(await existing.json()).toEqual({ status: 'existing' });
        expect(canProvision).not.toHaveBeenCalled();
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );
});
