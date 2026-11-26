import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { Database } from '../../database/index.js';
import type { IExternalApiKeyService } from '../../tool-auth/index.js';
import { createKbSyncRoutes } from '../../kb-sync/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import {
  InternalTokenService,
  createManualAuthMiddleware,
  createMcpAuthMiddleware,
} from '../../../__tests__/tool-wiring.js';
import { AuthService } from '../auth.service.js';
import { ACCOUNT_DEACTIVATED_MESSAGE, SESSION_ENDED_MESSAGE } from '../account-admission.js';
import { createAuthRoutes } from '../auth.routes.js';
import { createAccountRoutes } from '../account.routes.js';
import { AUTH_COOKIE_NAME, createAuthMiddleware } from '../auth.middleware.js';

/**
 * Rotating `ADMIN_PASSWORD` and restarting the deployment ends every session
 * the deployment admin opened with the old password, as a password change
 * does for a stored password. A restart is a new process on the same
 * database with the new environment, booted as the composition root boots it
 * (`endSessionsOfAnotherAdminPassword` before any request), so each boot here
 * is a fresh service and app on one real Postgres, crossed through the real
 * routes and the real auth middleware, by bearer token and by browser cookie,
 * and through every other surface that takes a session as its bearer: the
 * MCP endpoint, the agent manual routes and remote sync.
 */
const JWT_SECRET = 'test-jwt-secret';
const ADMIN_EMAIL = 'root@acme.test';
const MEMBER_EMAIL = 'member@acme.test';
/** Deployment admins of their own tests, so each starts with no row. */
const LATE_ADMIN_EMAIL = 'late-root@acme.test';
const NEXT_ADMIN_EMAIL = 'next-root@acme.test';
const SYNC_SECRET = 'a-very-long-and-random-sync-secret';

/** No connection key, OAuth token or internal token is presented here: the bearer is always a session. */
const noKeys = {
  looksLikeExternalApiKey: () => false,
  verifyAndLoadToken: async () => null,
} as unknown as IExternalApiKeyService;
const noOAuth = { looksLikeAccessToken: () => false } as unknown as Parameters<typeof createMcpAuthMiddleware>[2];
const internalTokens = new InternalTokenService({ secret: 'test-internal-secret-32-bytes-long!!' });
const ADMINS = new Set([ADMIN_EMAIL, MEMBER_EMAIL, LATE_ADMIN_EMAIL, NEXT_ADMIN_EMAIL]);
const isAdmin = async (email: string) => ADMINS.has(email);
const reached = (_req: express.Request, res: express.Response) => {
  res.json({ ok: true });
};

describe.skipIf(!PG_ADMIN_URL)('the deployment admin across an ADMIN_PASSWORD rotation, on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  const servers: Server[] = [];

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_envadmin_rotation'));
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    if (db) await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  /** The deployment, started with `adminPassword` as its `ADMIN_PASSWORD`: its base URL and auth service. */
  async function boot(adminPassword: string, adminEmail = ADMIN_EMAIL): Promise<{ base: string; auth: AuthService }> {
    const auth = new AuthService(db, {
      jwtSecret: JWT_SECRET,
      adminEmail,
      adminPassword,
      allowedEmailDomains: [],
    });
    await auth.endSessionsOfAnotherAdminPassword();
    const authMiddleware = createAuthMiddleware(auth);
    const app = express();
    // Remote sync parses its own body, so it is mounted before the JSON parser, as in production.
    app.use(
      '/api',
      createKbSyncRoutes({
        kbSync: { sync: async () => ({ status: 'synced', results: [], changeRequests: { closedDeletedBranch: 0 } }) },
        syncSecret: () => SYNC_SECRET,
        authService: auth,
        adminAccess: { isAdmin },
      }),
    );
    app.use(express.json());
    app.post(
      '/api/mcp',
      createMcpAuthMiddleware(auth, noKeys, noOAuth, 'https://acme.test/.well-known/oauth-protected-resource', internalTokens),
      reached,
    );
    app.get('/api/agent/utcp', createManualAuthMiddleware(noKeys, internalTokens, auth), reached);
    app.use('/api', createAuthRoutes(auth, authMiddleware));
    app.use(
      '/api',
      authMiddleware,
      createAccountRoutes(
        auth,
        { isAdmin },
        { eraseUser: async () => undefined },
        { runAccountInvited: async () => undefined, runAccountDeactivated: async () => undefined },
      ),
    );
    const server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('no port');
    return { base: `http://127.0.0.1:${address.port}`, auth };
  }

  function postLogin(base: string, email: string, password: string) {
    return fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }

  /** A sign-in: its bearer token, and the auth cookie a browser would keep. */
  async function signIn(base: string, password: string, email = ADMIN_EMAIL): Promise<{ token: string; cookie: string }> {
    const res = await postLogin(base, email, password);
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    if (!set) throw new Error('no auth cookie set');
    return { token: ((await res.json()) as { token: string }).token, cookie: set.split(';')[0] };
  }

  /** The methods the surfaces under test answer on; everything else is read with GET. */
  const POSTED = new Set(['/api/mcp', '/api/sync']);
  async function call(base: string, path: string, headers: Record<string, string>) {
    const res = await fetch(`${base}${path}`, { method: POSTED.has(path) ? 'POST' : 'GET', headers });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const cookie = (c: string) => ({ Cookie: c });
  const SURFACES = ['/api/auth/me', '/api/admin/accounts', '/api/mcp', '/api/agent/utcp', '/api/sync'] as const;
  const ENDED = { status: 401, body: { error: SESSION_ENDED_MESSAGE } };

  it(
    'answers 401, in words, to every earlier token and browser session once the deployment restarts with a new password',
    async () => {
      // The admin's row is made by its first sign-in, after the boot: a
      // restart under the same password keeps that first session.
      const { base: first } = await boot('original-password');
      const api = await signIn(first, 'original-password');
      const browser = await signIn(first, 'original-password');
      const { base: before } = await boot('original-password');
      for (const path of SURFACES) expect((await call(before, path, bearer(api.token))).status).toBe(200);
      expect((await call(before, '/api/auth/me', cookie(browser.cookie))).status).toBe(200);

      const { base: after } = await boot('rotated-password');
      for (const path of SURFACES) expect(await call(after, path, bearer(api.token))).toEqual(ENDED);
      for (const path of ['/api/auth/me', '/api/admin/accounts']) {
        expect(await call(after, path, cookie(browser.cookie))).toEqual(ENDED);
      }

      // The old password signs nobody in; the new one does, and its session
      // survives a further restart that leaves the password as it is.
      expect((await postLogin(after, ADMIN_EMAIL, 'original-password')).status).toBe(401);
      const fresh = await signIn(after, 'rotated-password');
      for (const path of SURFACES) expect((await call(after, path, bearer(fresh.token))).status).toBe(200);
      const { base: unchanged } = await boot('rotated-password');
      expect((await call(unchanged, '/api/auth/me', bearer(fresh.token))).status).toBe(200);
      expect((await call(unchanged, '/api/auth/me', cookie(fresh.cookie))).status).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'does not revive the sessions of an earlier password when ADMIN_PASSWORD is set back to it',
    async () => {
      const { base: a } = await boot('password-a');
      const underA = await signIn(a, 'password-a');
      await boot('password-b');
      const { base: againA } = await boot('password-a');
      for (const path of SURFACES) expect(await call(againA, path, bearer(underA.token))).toEqual(ENDED);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'ends the sessions the deployment admin opened through single sign-on as well',
    async () => {
      const { auth } = await boot('sso-era-password');
      const { token } = await auth.loginWithSso(ADMIN_EMAIL, 'Root');
      const { base: same } = await boot('sso-era-password');
      expect((await call(same, '/api/auth/me', bearer(token))).status).toBe(200);
      const { base: rotated } = await boot('after-sso-password');
      for (const path of SURFACES) expect(await call(rotated, path, bearer(token))).toEqual(ENDED);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'accepts no session a process still running under the old password opens, by password or single sign-on',
    async () => {
      const { base: old, auth: oldAuth } = await boot('outgoing-password');
      await signIn(old, 'outgoing-password');
      const { base: next } = await boot('incoming-password');
      // The old half of a rolling restart still runs under the old password
      // and opens sessions; the new half accepts none of them.
      const byPassword = await signIn(old, 'outgoing-password');
      const { token: bySso } = await oldAuth.loginWithSso(ADMIN_EMAIL, 'Root');
      for (const token of [byPassword.token, bySso]) {
        for (const path of SURFACES) expect(await call(next, path, bearer(token))).toEqual(ENDED);
      }
      expect(await call(next, '/api/auth/me', cookie(byPassword.cookie))).toEqual(ENDED);
      // Nor does the old half accept the new half's sessions.
      const fresh = await signIn(next, 'incoming-password');
      for (const path of SURFACES) expect((await call(next, path, bearer(fresh.token))).status).toBe(200);
      expect(await call(old, '/api/auth/me', bearer(fresh.token))).toEqual(ENDED);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'accepts no session of the old password when its process makes the admin row after the new one booted',
    async () => {
      const { base: old } = await boot('outgoing-password', LATE_ADMIN_EMAIL);
      // No row yet when the new process boots: nothing for its boot to move on.
      const { base: next } = await boot('incoming-password', LATE_ADMIN_EMAIL);
      const underOld = await signIn(old, 'outgoing-password', LATE_ADMIN_EMAIL);
      for (const path of SURFACES) expect(await call(next, path, bearer(underOld.token))).toEqual(ENDED);
      const underNew = await signIn(next, 'incoming-password', LATE_ADMIN_EMAIL);
      for (const path of SURFACES) expect((await call(next, path, bearer(underNew.token))).status).toBe(200);
      // A process under the old password that boots later still has its
      // sessions refused by the new process, which keeps accepting its own.
      const { base: lateOld } = await boot('outgoing-password', LATE_ADMIN_EMAIL);
      const afterLateBoot = await signIn(lateOld, 'outgoing-password', LATE_ADMIN_EMAIL);
      expect(await call(next, '/api/auth/me', bearer(afterLateBoot.token))).toEqual(ENDED);
      const again = await signIn(next, 'incoming-password', LATE_ADMIN_EMAIL);
      expect((await call(next, '/api/auth/me', bearer(again.token))).status).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    "ends the former deployment admin's sessions when ADMIN_EMAIL moves, and moving it back revives none",
    async () => {
      const { base } = await boot('moving-email-password', NEXT_ADMIN_EMAIL);
      const { token } = await signIn(base, 'moving-email-password', NEXT_ADMIN_EMAIL);
      const { base: moved } = await boot('moving-email-password', 'someone-else@acme.test');
      expect(await call(moved, '/api/auth/me', bearer(token))).toEqual(ENDED);
      const { base: back } = await boot('moving-email-password', NEXT_ADMIN_EMAIL);
      for (const path of SURFACES) expect(await call(back, path, bearer(token))).toEqual(ENDED);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'ends the sessions of the address once ADMIN_PASSWORD is unset and it is an ordinary account again',
    async () => {
      const { base } = await boot('last-env-password');
      const { token } = await signIn(base, 'last-env-password');
      const { base: unset } = await boot('');
      expect(await call(unset, '/api/auth/me', bearer(token))).toEqual(ENDED);
    },
    PG_TEST_TIMEOUT,
  );

  it(
    'answers a switched-off account, in words, on the MCP endpoint, the agent manual routes and remote sync',
    async () => {
      const { base, auth } = await boot('member-era-password');
      const member = await auth.createAccount(MEMBER_EMAIL, 'Member', 'member-password-long');
      const { token } = await signIn(base, 'member-password-long', MEMBER_EMAIL);
      for (const path of ['/api/mcp', '/api/agent/utcp', '/api/sync']) {
        expect((await call(base, path, bearer(token))).status).toBe(200);
      }
      expect(await auth.deactivate(member.id)).toBe(true);
      for (const path of ['/api/mcp', '/api/agent/utcp', '/api/sync']) {
        expect(await call(base, path, bearer(token))).toEqual({ status: 401, body: { error: ACCOUNT_DEACTIVATED_MESSAGE } });
      }
    },
    PG_TEST_TIMEOUT,
  );
});
