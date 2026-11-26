import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService } from '../auth.service.js';
import { SESSION_ENDED_MESSAGE } from '../account-admission.js';
import { createAuthRoutes } from '../auth.routes.js';
import { createAccountRoutes } from '../account.routes.js';
import { AUTH_COOKIE_NAME, createAuthMiddleware } from '../auth.middleware.js';

/**
 * Rotating `ADMIN_PASSWORD` and restarting the deployment ends every session
 * the deployment admin opened with the old password, as a password change
 * does for a stored password. A restart is a new process on the same
 * database with the new environment, so each boot here is a fresh service
 * and app on one real Postgres, crossed through the real routes and the real
 * auth middleware, by bearer token and by browser cookie.
 */
const JWT_SECRET = 'test-jwt-secret';
const ADMIN_EMAIL = 'root@acme.test';

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

  /** The deployment, started with `adminPassword` as its `ADMIN_PASSWORD`; answers its base URL. */
  async function boot(adminPassword: string): Promise<string> {
    const auth = new AuthService(db, {
      jwtSecret: JWT_SECRET,
      adminEmail: ADMIN_EMAIL,
      adminPassword,
      allowedEmailDomains: [],
    });
    const authMiddleware = createAuthMiddleware(auth);
    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRoutes(auth, authMiddleware));
    app.use(
      '/api',
      authMiddleware,
      createAccountRoutes(
        auth,
        { isAdmin: async (email) => email === ADMIN_EMAIL },
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
    return `http://127.0.0.1:${address.port}`;
  }

  /** A sign-in: its bearer token, and the auth cookie a browser would keep. */
  async function signIn(base: string, password: string): Promise<{ token: string; cookie: string }> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password }),
    });
    expect(res.status).toBe(200);
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${AUTH_COOKIE_NAME}=`));
    if (!set) throw new Error('no auth cookie set');
    return { token: ((await res.json()) as { token: string }).token, cookie: set.split(';')[0] };
  }

  async function call(base: string, path: string, headers: Record<string, string>) {
    const res = await fetch(`${base}${path}`, { headers });
    return { status: res.status, body: (await res.json()) as { error?: string } };
  }
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const cookie = (c: string) => ({ Cookie: c });

  it(
    'answers 401, in words, to every earlier token and browser session once the deployment restarts with a new password',
    async () => {
      const before = await boot('original-password');
      const api = await signIn(before, 'original-password');
      const browser = await signIn(before, 'original-password');
      expect((await call(before, '/api/auth/me', bearer(api.token))).status).toBe(200);
      expect((await call(before, '/api/admin/accounts', bearer(api.token))).status).toBe(200);
      expect((await call(before, '/api/auth/me', cookie(browser.cookie))).status).toBe(200);

      const after = await boot('rotated-password');
      for (const [path, headers] of [
        ['/api/auth/me', bearer(api.token)],
        ['/api/admin/accounts', bearer(api.token)],
        ['/api/auth/me', cookie(browser.cookie)],
        ['/api/admin/accounts', cookie(browser.cookie)],
      ] as const) {
        expect(await call(after, path, headers)).toEqual({ status: 401, body: { error: SESSION_ENDED_MESSAGE } });
      }

      // The old password signs nobody in; the new one does, and its session
      // survives a further restart that leaves the password as it is.
      const old = await fetch(`${after}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: 'original-password' }),
      });
      expect(old.status).toBe(401);
      const fresh = await signIn(after, 'rotated-password');
      expect((await call(after, '/api/admin/accounts', bearer(fresh.token))).status).toBe(200);
      const unchanged = await boot('rotated-password');
      expect((await call(unchanged, '/api/auth/me', bearer(fresh.token))).status).toBe(200);
      expect((await call(unchanged, '/api/auth/me', cookie(fresh.cookie))).status).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );
});
