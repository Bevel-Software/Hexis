import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService } from '../auth.service.js';
import { createInvitationRoutes } from '../invitation.routes.js';
import { AccountHooks } from '../account-hooks.js';
import { admitEveryone, type IAccountAdmission } from '../index.js';
import { hashPassword } from '../password-hash.js';
import { RECOVERY_BOT_EMAIL } from '../../version-control/index.js';
import { DIRECTORY_SYNC_BOT_EMAIL } from '../../access/index.js';

// The real hash, counted: an invite of an address that already has an
// account must not pay for one.
vi.mock('../password-hash.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../password-hash.js')>();
  return { ...real, hashPassword: vi.fn(real.hashPassword) };
});

/**
 * An invitation makes a NEW account and writes nothing to one that is
 * there: the insert does nothing on conflict, which no stub can stand in
 * for, so this crosses a real Postgres (see `pg-scratch.ts`) through the
 * route a member's dialog calls.
 */
const closers: (() => Promise<void>)[] = [];

async function startApp(
  opts: {
    admission?: IAccountAdmission;
    adminEmail?: string;
    adminPassword?: string;
    /** The deployment's listeners (its mail, its companion); none by default. */
    hooks?: AccountHooks;
    /** Addresses `roles.yaml` lists under Admin before they have accounts. */
    admins?: string[];
  } = {},
): Promise<{ base: string; auth: AuthService; db: Database; close(): void }> {
  const { db, close } = await openMigratedScratchDb('hexis_invite');
  closers.push(close);
  const auth = new AuthService(
    db,
    {
      jwtSecret: 'test-jwt-secret',
      adminEmail: opts.adminEmail ?? '',
      adminPassword: opts.adminPassword ?? (opts.adminEmail ? 'the-environment-password' : ''),
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
    createInvitationRoutes(
      auth,
      { isAdmin: async () => false, holdsAdmin: async (email) => (opts.admins ?? []).includes(email) },
      opts.hooks ?? new AccountHooks(),
      { passwordSignIn: true, providers: [] },
    ),
  );
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}`, auth, db, close: () => server.close() };
}

/** Listeners that record what each invited event carried about a password. */
function recordingInvites(): { hooks: AccountHooks; events: { passwordSet: boolean; startingPassword?: string }[] } {
  const hooks = new AccountHooks();
  const events: { passwordSet: boolean; startingPassword?: string }[] = [];
  hooks.onAccountInvited(async (event) => {
    events.push({ passwordSet: event.passwordSet, startingPassword: event.startingPassword });
    return 'email';
  });
  return { hooks, events };
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
      const { hooks, events } = recordingInvites();
      const app = await startApp({ adminEmail: 'owner@acme.test', hooks });
      try {
        const res = await invite(app.base, { email: 'owner@acme.test' });
        expect(res.status).toBe(201);
        expect(await res.json()).not.toHaveProperty('startingPassword');
        expect(events).toEqual([{ passwordSet: false, startingPassword: undefined }]);
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'owner@acme.test'));
        expect(row!.passwordHash).toBeNull();
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    "gives an owner's address no password with ADMIN_PASSWORD unset either, so a member can't sign in as an owner who hasn't yet",
    async () => {
      const { hooks, events } = recordingInvites();
      const app = await startApp({ adminEmail: 'owner@acme.test', adminPassword: '', hooks });
      try {
        const res = await invite(app.base, { email: 'Owner@Acme.test', startingPassword: true });
        expect(res.status).toBe(201);
        expect(await res.json()).not.toHaveProperty('startingPassword');
        expect(events).toEqual([{ passwordSet: false, startingPassword: undefined }]);
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'owner@acme.test'));
        expect(row!.passwordHash).toBeNull();
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'gives the platform accounts no password: none returned, none on the event, no hash stored',
    async () => {
      const hooks = new AccountHooks();
      const events: { email: string; passwordSet: boolean; startingPassword?: string }[] = [];
      hooks.onAccountInvited(async (event) => {
        events.push({ email: event.account.email, passwordSet: event.passwordSet, startingPassword: event.startingPassword });
        return 'email';
      });
      const app = await startApp({ hooks });
      try {
        for (const email of [RECOVERY_BOT_EMAIL, DIRECTORY_SYNC_BOT_EMAIL]) {
          const res = await invite(app.base, { email: email.toUpperCase(), startingPassword: true });
          expect(res.status).toBe(201);
          const body = (await res.json()) as Record<string, unknown>;
          expect(body.status).toBe('created');
          expect(body).not.toHaveProperty('startingPassword');
          expect(body).not.toHaveProperty('passwordDeliveredBy');
          const [row] = await app.db.select().from(users).where(eq(users.emailBidx, email));
          expect(row!.passwordHash).toBeNull();
        }
        expect(events).toEqual([
          { email: RECOVERY_BOT_EMAIL, passwordSet: false, startingPassword: undefined },
          { email: DIRECTORY_SYNC_BOT_EMAIL, passwordSet: false, startingPassword: undefined },
        ]);
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'a password a listener delivered signs the person in, and the member is not handed it',
    async () => {
      const hooks = new AccountHooks();
      let mailed = '';
      hooks.onAccountInvited(async (event) => {
        mailed = event.startingPassword ?? '';
        return { channel: 'email', deliveredStartingPassword: true };
      });
      const app = await startApp({ hooks });
      try {
        const res = await invite(app.base, { email: 'mailed@acme.test' });
        expect(res.status).toBe(201);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty('startingPassword');
        expect(body.passwordDeliveredBy).toEqual(['email']);
        expect(mailed).toHaveLength(16);
        expect((await app.auth.loginWithPassword('mailed@acme.test', mailed)).user.email).toBe('mailed@acme.test');
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    "an Admin's address invited by a member, with nobody to deliver its password: the account is left with none",
    async () => {
      const hooks = new AccountHooks();
      let offered = '';
      hooks.onAccountInvited(async (event) => {
        offered = event.startingPassword ?? '';
        return 'email'; // announced the invite, without the password
      });
      const app = await startApp({ hooks, admins: ['boss@acme.test'] });
      try {
        const res = await invite(app.base, { email: 'Boss@Acme.test' });
        expect(res.status).toBe(201);
        expect(await res.json()).not.toHaveProperty('startingPassword');
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'boss@acme.test'));
        expect(row!.passwordHash).toBeNull();
        await expect(app.auth.loginWithPassword('boss@acme.test', offered)).rejects.toThrow();
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'discarding a starting password leaves alone a password set on the account meanwhile',
    async () => {
      const app = await startApp();
      try {
        const made = await app.auth.createInvitedAccount('race@acme.test', { startingPassword: true });
        if (!made.created || !made.startingPassword) throw new Error('expected a new account with a password');
        // An admin sets a password in User accounts before the discard runs.
        await app.auth.createAccount('race@acme.test', 'Race', 'set-by-an-admin-123');
        expect(await app.auth.discardStartingPassword(made.user.id, made.startingPassword)).toBe(false);
        expect((await app.auth.loginWithPassword('race@acme.test', 'set-by-an-admin-123')).user.email).toBe('race@acme.test');
        // Untouched, it is taken back.
        const other = await app.auth.createInvitedAccount('other@acme.test', { startingPassword: true });
        if (!other.created || !other.startingPassword) throw new Error('expected a new account with a password');
        expect(await app.auth.discardStartingPassword(other.user.id, other.startingPassword)).toBe(true);
        const [row] = await app.db.select().from(users).where(eq(users.emailBidx, 'other@acme.test'));
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

  it(
    'hashes no password for an address that already has an account',
    async () => {
      const app = await startApp();
      try {
        await app.db.insert(users).values({ email: 'old@acme.test', emailBidx: 'old@acme.test', name: 'old' });
        vi.mocked(hashPassword).mockClear();
        const existing = await invite(app.base, { email: 'Old@Acme.test' });
        expect(await existing.json()).toEqual({ status: 'existing' });
        expect(hashPassword).not.toHaveBeenCalled();
        // A new address on the same deployment does get one hashed.
        expect((await invite(app.base, { email: 'new@acme.test' })).status).toBe(201);
        expect(hashPassword).toHaveBeenCalledTimes(1);
      } finally {
        app.close();
      }
    },
    PG_TEST_TIMEOUT,
  );
});
