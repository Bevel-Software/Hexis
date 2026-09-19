import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAccountRoutes } from '../account.routes.js';
import { AuthService } from '../auth.service.js';
import { hashPassword } from '../password-hash.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

const authService = {
  listAccounts: vi.fn(async () => [
    { id: 'u1', email: 'a@example.com', name: 'A', hasPassword: true, createdAt: new Date() },
  ]),
  createAccount: vi.fn(async (email: string) => ({ id: 'u2', email, name: 'B' })),
} as unknown as AuthService;

// Satisfies the route's narrow Pick<IAccountErasureService, 'eraseUser'>
// contract directly — no concrete-service cast needed.
const accountErasure = {
  eraseUser: vi.fn(async (_userId: string) => true),
};

function makeApp(opts: { admin: boolean; email?: string }) {
  const adminAccess: IAdminAccessService = {
    isAdmin: vi.fn(async () => opts.admin),
  };
  const app = express();
  app.use(express.json());
  // Stand-in auth middleware: stamps the caller identity the way the real JWT
  // middleware does.
  app.use((req, _res, next) => {
    req.userId = 'u1';
    req.userEmail = opts.email ?? 'caller@example.com';
    next();
  });
  app.use('/api', createAccountRoutes(authService, adminAccess, accountErasure));
  return app;
}

let server: Server;
afterEach(() => {
  server?.close();
  vi.mocked(authService.createAccount).mockClear();
  vi.mocked(accountErasure.eraseUser).mockClear().mockResolvedValue(true);
});

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('account routes — admin gate', () => {
  it('refuses non-admins on both endpoints', async () => {
    const base = await listen(makeApp({ admin: false }));
    const list = await fetch(`${base}/api/admin/accounts`);
    expect(list.status).toBe(403);
    const create = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com', password: 'long-enough-pw' }),
    });
    expect(create.status).toBe(403);
    expect(authService.createAccount).not.toHaveBeenCalled();
  });

  it('serves admins: list + create', async () => {
    const base = await listen(makeApp({ admin: true }));
    const list = await fetch(`${base}/api/admin/accounts`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { accounts: Array<{ email: string }> };
    expect(listBody.accounts[0].email).toBe('a@example.com');

    const create = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@example.com', name: 'B', password: 'long-enough-pw' }),
    });
    expect(create.status).toBe(201);
    expect(authService.createAccount).toHaveBeenCalledWith('b@example.com', 'B', 'long-enough-pw');
  });

  it('list reports hasPassword + isEnvAdmin and never carries a hash or password', async () => {
    const passwordHash = await hashPassword('stored-password-1');
    const rows = [
      { id: 'u1', email: 'root@example.com', name: 'Root', passwordHash: null, createdAt: new Date() },
      { id: 'u2', email: 'b@example.com', name: 'B', passwordHash, createdAt: new Date() },
    ];
    // A real AuthService over a stub db — the route's body is what the
    // service produces from full `users` rows, hash column included.
    const db = {
      select: () => ({ from: () => ({ orderBy: async () => rows }) }),
    } as unknown as Database;
    const realAuth = new AuthService(db, {
      jwtSecret: 'test-jwt-secret',
      adminEmail: 'root@example.com',
      adminPassword: 'env-admin-secret',
      allowedEmailDomains: [],
    });
    const app = express();
    app.use((req, _res, next) => {
      req.userId = 'caller';
      req.userEmail = 'caller@example.com';
      next();
    });
    app.use('/api', createAccountRoutes(realAuth, { isAdmin: async () => true }, accountErasure));
    const base = await listen(app);

    const res = await fetch(`${base}/api/admin/accounts`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      accounts: Array<{ email: string; hasPassword: boolean; isEnvAdmin: boolean }>;
    };
    expect(body.accounts.map((a) => [a.email, a.hasPassword, a.isEnvAdmin])).toEqual([
      ['root@example.com', false, true],
      ['b@example.com', true, false],
    ]);
    expect(text).not.toContain('scrypt:');
    expect(text).not.toContain('passwordHash');
    expect(text).not.toContain('env-admin-secret');
    expect(text).not.toContain('stored-password-1');
  });

  it('erasure: refuses non-admins, refuses self, 404s unknown, 204s success', async () => {
    const nonAdmin = await listen(makeApp({ admin: false }));
    expect((await fetch(`${nonAdmin}/api/admin/accounts/u9`, { method: 'DELETE' })).status).toBe(403);
    expect(accountErasure.eraseUser).not.toHaveBeenCalled();
    server.close();

    const base = await listen(makeApp({ admin: true }));
    // Self-erasure (caller is stamped as u1) is refused with an explanation.
    const self = await fetch(`${base}/api/admin/accounts/u1`, { method: 'DELETE' });
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error: string }).error).toMatch(/own account/i);
    expect(accountErasure.eraseUser).not.toHaveBeenCalled();

    vi.mocked(accountErasure.eraseUser).mockResolvedValueOnce(false);
    expect((await fetch(`${base}/api/admin/accounts/ghost`, { method: 'DELETE' })).status).toBe(404);

    expect((await fetch(`${base}/api/admin/accounts/u2`, { method: 'DELETE' })).status).toBe(204);
    expect(accountErasure.eraseUser).toHaveBeenLastCalledWith('u2');
  });

  it('erasure failure → 500 with a generic body (no internal error text)', async () => {
    const base = await listen(makeApp({ admin: true }));
    vi.mocked(accountErasure.eraseUser).mockRejectedValueOnce(
      new Error('relation "users" does not exist'),
    );
    const res = await fetch(`${base}/api/admin/accounts/u2`, { method: 'DELETE' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to erase user');
    expect(JSON.stringify(body)).not.toContain('relation');
  });

  it('400s on missing fields and surfaces service validation errors', async () => {
    const base = await listen(makeApp({ admin: true }));
    const missing = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@example.com' }),
    });
    expect(missing.status).toBe(400);

    vi.mocked(authService.createAccount).mockRejectedValueOnce(
      new Error('Password must be at least 8 characters'),
    );
    const tooShort = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@example.com', password: 'short' }),
    });
    expect(tooShort.status).toBe(400);
    const body = (await tooShort.json()) as { error: string };
    expect(body.error).toContain('at least 8');
  });
});
