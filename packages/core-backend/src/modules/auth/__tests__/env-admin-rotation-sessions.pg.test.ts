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
import { createMcpAuthMiddleware } from '../../mcp/mcp-auth.middleware.js';
import type { BevelOAuthProvider } from '../../mcp/oauth/bevel-oauth-provider.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createManualAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import { createKbSyncRoutes } from '../../kb-sync/kb-sync.routes.js';

/**
 * Rotating `ADMIN_PASSWORD` and restarting the deployment ends every session
 * the deployment admin opened with the old password, as a password change
 * does for a stored password. A restart is a new process on the same
 * database with the new environment, so each boot here is a fresh service
 * and app on one real Postgres, crossed through the real routes and the real
 * auth middleware, by bearer token and by browser cookie — and through every
 * other surface that takes a session as its bearer: the MCP endpoint, the
 * agent manual routes and remote sync.
 */
const JWT_SECRET = 'test-jwt-secret';
const ADMIN_EMAIL = 'root@acme.test';
const SYNC_SECRET = 'a-very-long-and-random-sync-secret';

/** No connection key, OAuth token or internal token is presented here: the bearer is always a session. */
const noKeys = {
  looksLikeExternalApiKey: () => false,
  verifyAndLoadToken: async () => null,
} as unknown as IExternalApiKeyService;
const noOAuth = { looksLikeAccessToken: () => false } as unknown as BevelOAuthProvider;
const internalTokens = new InternalTokenService({ secret: 'test-internal-secret-32-bytes-long!!' });
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
    // Remote sync parses its own body, so it is mounted before the JSON parser, as in production.
    app.use(
      '/api',
      createKbSyncRoutes({
        kbSync: { sync: async () => ({ status: 'synced', results: [], changeRequests: { closedDeletedBranch: 0 } }) },
        syncSecret: () => SYNC_SECRET,
        authService: auth,
        adminAccess: { isAdmin: async (email) => email === ADMIN_EMAIL },
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

  /** The methods the surfaces under test answer on; everything else is read with GET. */
  const POSTED = new Set(['/api/mcp', '/api/sync']);
  async function call(base: string, path: string, headers: Record<string, string>) {
    const res = await fetch(`${base}${path}`, { method: POSTED.has(path) ? 'POST' : 'GET', headers });
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
      for (const path of ['/api/mcp', '/api/agent/utcp', '/api/sync']) {
        expect((await call(before, path, bearer(api.token))).status).toBe(200);
      }

      const after = await boot('rotated-password');
      for (const [path, headers] of [
        ['/api/auth/me', bearer(api.token)],
        ['/api/admin/accounts', bearer(api.token)],
        ['/api/auth/me', cookie(browser.cookie)],
        ['/api/admin/accounts', cookie(browser.cookie)],
        ['/api/mcp', bearer(api.token)],
        ['/api/agent/utcp', bearer(api.token)],
        ['/api/sync', bearer(api.token)],
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
      for (const path of ['/api/mcp', '/api/agent/utcp', '/api/sync']) {
        expect((await call(after, path, bearer(fresh.token))).status).toBe(200);
      }
      const unchanged = await boot('rotated-password');
      expect((await call(unchanged, '/api/auth/me', bearer(fresh.token))).status).toBe(200);
      expect((await call(unchanged, '/api/auth/me', cookie(fresh.cookie))).status).toBe(200);
    },
    PG_TEST_TIMEOUT,
  );
});
