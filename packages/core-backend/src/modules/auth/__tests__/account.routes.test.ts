import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAccountRoutes } from '../account.routes.js';
import { AuthService } from '../auth.service.js';
import { AccountAdmissionRefusedError, AccountChangeRefusedError } from '../account-admission.js';
import { hashPassword } from '../password-hash.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

const authService = {
  listAccounts: vi.fn(async () => [
    { id: 'u1', email: 'a@example.com', name: 'A', hasPassword: true, createdAt: new Date() },
  ]),
  createAccount: vi.fn(async (email: string) => ({ id: 'u2', email, name: 'B' })),
  deactivate: vi.fn(async (userId: string) => userId !== 'missing'),
  reactivate: vi.fn(async (userId: string) => userId !== 'missing'),
  getUserById: vi.fn(async (id: string) => (id === 'missing' ? null : { id, email: `${id}@example.com`, name: id })),
  isOwnerEmail: vi.fn((email: string) => email.trim().toLowerCase() === 'root@example.com'),
  assertDeletable: vi.fn(() => {}),
} as unknown as AuthService;

// Satisfies the route's narrow Pick<IAccountErasureService, 'eraseUser'>
// contract directly — no concrete-service cast needed.
const accountErasure = {
  eraseUser: vi.fn<(userId: string, opts?: { erasureId?: string }) => Promise<boolean>>(async () => true),
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
    // Not an admission refusal: nothing here may read as "no seat left".
    expect(await create.json()).toEqual({ error: 'Admins only' });
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
    // service produces from full `users` rows, hash column included. The
    // listing is sorted in-process (the email column is ciphertext in the
    // database), so the read is a bare `select().from()`.
    const db = {
      select: () => ({ from: async () => rows }),
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
    // Sorted by email in-process, since the column is ciphertext in the database.
    expect(body.accounts.map((a) => [a.email, a.hasPassword, a.isEnvAdmin])).toEqual([
      ['b@example.com', true, false],
      ['root@example.com', false, true],
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

  it('an account the admission port refuses → 403 carrying the port\'s own words, marked as an admission refusal', async () => {
    const base = await listen(makeApp({ admin: true }));
    vi.mocked(authService.createAccount).mockRejectedValueOnce(
      new AccountAdmissionRefusedError('No seat left on this plan'),
    );
    const refused = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'b@example.com', password: 'long-enough-pw' }),
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'No seat left on this plan', kind: 'admission' });
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

  it('400s without an email (a password is optional) and surfaces service validation errors', async () => {
    const base = await listen(makeApp({ admin: true }));
    const missing = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
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

describe('account routes — removing the erased address from access files', () => {
  const lee = { id: 'u2', email: 'lee@example.com', name: 'Lee' };
  const caller = { id: 'u1', email: 'caller@example.com', name: 'Caller' };

  function makeRemovalApp() {
    const auth = {
      ...authService,
      getUserById: vi.fn(async (id: string) => (id === 'u2' ? lee : id === 'u1' ? caller : null)),
    } as unknown as AuthService;
    const accessRemoval = {
      report: vi.fn(async () => ({
        roles: 1,
        groups: 1,
        accessRules: 2,
        fileGrants: 1,
        total: 5,
        files: ['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml'],
        removable: true,
        blockedReason: null,
        unwritable: ['Sales/Plan.md'],
      })),
      assertRemovable: vi.fn(async () => {}),
      remove: vi.fn(async () => ({ removedFrom: ['roles.yaml'], stillNamedIn: [] as string[] | null })),
      filesNaming: vi.fn(async (): Promise<string[]> => ['Sales/access.md', 'roles.yaml']),
    };
    const app = express();
    app.use((req, _res, next) => {
      req.userId = 'u1';
      req.userEmail = 'caller@example.com';
      next();
    });
    app.use('/api', createAccountRoutes(auth, { isAdmin: async () => true }, accountErasure, accessRemoval));
    return { app, accessRemoval };
  }

  it('reports the reference counts for the confirmation, without the address', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2/references`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ total: 5, roles: 1, groups: 1, accessRules: 2, fileGrants: 1 });
    // The TARGET's address is counted; the ACTING admin's decides what they
    // can write, so the dialog can warn before the delete.
    expect(accessRemoval.report).toHaveBeenCalledWith('lee@example.com', 'caller@example.com');
    expect(JSON.parse(text).unwritable).toEqual(['Sales/Plan.md']);
    expect(text).not.toContain('lee@example.com');
    expect((await fetch(`${base}/api/admin/accounts/ghost/references`)).status).toBe(404);
  });

  it('option off: erases as today (204) and never touches the access files', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(accountErasure.eraseUser).toHaveBeenLastCalledWith('u2');
    expect(accessRemoval.assertRemovable).not.toHaveBeenCalled();
    expect(accessRemoval.remove).not.toHaveBeenCalled();
  });

  it('option on: erases, then removes in one call named by the anonymised id', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2?removeFromAccess=1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { erased: boolean; accessRemoval: { ok: boolean; removedFrom: string[] } };
    expect(body).toEqual({ erased: true, accessRemoval: { ok: true, removedFrom: ['roles.yaml'], stillNamedIn: [] } });

    const [, opts] = vi.mocked(accountErasure.eraseUser).mock.calls.at(-1)! as unknown as [string, { erasureId: string }];
    expect(opts.erasureId).toMatch(/^[0-9a-f-]{36}$/);
    expect(accessRemoval.remove).toHaveBeenCalledTimes(1);
    const [actor, email, accountId] = accessRemoval.remove.mock.calls[0] as unknown as [
      { email: string },
      string,
      string,
    ];
    expect(actor.email).toBe('caller@example.com');
    expect(email).toBe('lee@example.com');
    expect(accountId).toBe(`deleted-${opts.erasureId}`);
    // Erasure happened before the removal.
    expect(vi.mocked(accountErasure.eraseUser).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      accessRemoval.remove.mock.invocationCallOrder[0],
    );
  });

  it('commit failure: the account is still erased and the response lists the files still naming the user', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    accessRemoval.remove.mockRejectedValueOnce(new Error('push rejected: /srv/kb internal detail'));
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2?removeFromAccess=1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      erased: boolean;
      accessRemoval: { ok: boolean; error: string; stillNamedIn: string[] };
    };
    expect(accountErasure.eraseUser).toHaveBeenCalledTimes(1);
    expect(body.erased).toBe(true);
    expect(body.accessRemoval.ok).toBe(false);
    expect(body.accessRemoval.stillNamedIn).toEqual(['Sales/access.md', 'roles.yaml']);
    expect(text).not.toContain('/srv/kb');
    expect(text).not.toContain('lee@example.com');
  });

  it('commit failure with an unreadable re-scan reports the files as unknown, not as none', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    accessRemoval.remove.mockRejectedValueOnce(new Error('push rejected'));
    accessRemoval.filesNaming.mockRejectedValueOnce(new Error('EACCES'));
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2?removeFromAccess=1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { erased: boolean; accessRemoval: { ok: boolean; stillNamedIn: string[] | null } };
    expect(body.erased).toBe(true);
    expect(body.accessRemoval.ok).toBe(false);
    expect(body.accessRemoval.stillNamedIn).toBeNull();
  });

  it('the guards refuse up front: nothing is erased', async () => {
    const { app, accessRemoval } = makeRemovalApp();
    const { WorkflowDomainError } = await import('../../../shared/domain-errors.js');
    accessRemoval.assertRemovable.mockRejectedValueOnce(
      new WorkflowDomainError('This is the last Admin; the Admin role must keep at least one direct email member.', 409),
    );
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/u2?removeFromAccess=1`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/last Admin/);
    expect(accountErasure.eraseUser).not.toHaveBeenCalled();
    expect(accessRemoval.remove).not.toHaveBeenCalled();
  });
});

describe('account routes — switching an account off and on', () => {
  const post = (base: string, path: string) => fetch(`${base}/api/admin/accounts/${path}`, { method: 'POST' });

  it('switches another account off and back on', async () => {
    const base = await listen(makeApp({ admin: true }));
    expect((await post(base, 'u2/deactivate')).status).toBe(204);
    expect(authService.deactivate).toHaveBeenCalledWith('u2');
    expect((await post(base, 'u2/reactivate')).status).toBe(204);
    expect(authService.reactivate).toHaveBeenCalledWith('u2');
  });

  it('refuses an admin switching off their own account, so an admin who can sign in always remains', async () => {
    vi.mocked(authService.deactivate).mockClear();
    const base = await listen(makeApp({ admin: true }));
    const res = await post(base, 'u1/deactivate');
    expect(res.status).toBe(400);
    expect(authService.deactivate).not.toHaveBeenCalled();
  });

  it('refuses non-admins', async () => {
    vi.mocked(authService.deactivate).mockClear();
    const base = await listen(makeApp({ admin: false }));
    expect((await post(base, 'u2/deactivate')).status).toBe(403);
    expect((await post(base, 'u2/reactivate')).status).toBe(403);
    expect(authService.deactivate).not.toHaveBeenCalled();
  });

  it('404s for an account that does not exist', async () => {
    const base = await listen(makeApp({ admin: true }));
    expect((await post(base, 'missing/deactivate')).status).toBe(404);
    expect((await post(base, 'missing/reactivate')).status).toBe(404);
  });

  it("answers a reactivation the deployment has no room for with 403 and the port's words", async () => {
    vi.mocked(authService.reactivate).mockRejectedValueOnce(new AccountAdmissionRefusedError('All 3 seats are taken'));
    const base = await listen(makeApp({ admin: true }));
    const res = await post(base, 'u2/reactivate');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'All 3 seats are taken', kind: 'admission' });
  });

  it('answers a refused deactivation (the owner, say) with 400 and the reason', async () => {
    vi.mocked(authService.deactivate).mockRejectedValueOnce(new AccountChangeRefusedError("The owner can't be switched off."));
    const base = await listen(makeApp({ admin: true }));
    const res = await post(base, 'u2/deactivate');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("The owner can't be switched off.");
  });

  it('answers an unexpected failure with a 500 that names nothing of it', async () => {
    vi.mocked(authService.deactivate).mockRejectedValueOnce(new Error('relation "users" does not exist'));
    vi.mocked(authService.reactivate).mockRejectedValueOnce(new Error('relation "users" does not exist'));
    const base = await listen(makeApp({ admin: true }));
    const off = await post(base, 'u2/deactivate');
    expect(off.status).toBe(500);
    expect(JSON.stringify(await off.json())).not.toContain('relation');
    const on = await post(base, 'u2/reactivate');
    expect(on.status).toBe(500);
    expect(JSON.stringify(await on.json())).not.toContain('relation');
  });

  it('refuses a password that is not a string, rather than making an account for single sign-on', async () => {
    vi.mocked(authService.createAccount).mockClear();
    const base = await listen(makeApp({ admin: true }));
    for (const password of [false, null, 0]) {
      const res = await fetch(`${base}/api/admin/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'b@example.com', password }),
      });
      expect(res.status).toBe(400);
    }
    expect(authService.createAccount).not.toHaveBeenCalled();
  });
});

/**
 * The owner (`ADMIN_EMAIL`) through the accounts API, against a real
 * AuthService, on a deployment with a server-held owner password
 * (self-hosted) and one without (the cloud's configuration). The refusals
 * live on the server, so they hold for every caller, not only the page.
 */
describe('account routes — the owner cannot be locked out', () => {
  const OWNER_ROW = {
    id: 'owner',
    email: 'root@example.com',
    name: 'Root',
    avatarUrl: null,
    onboardingDone: true,
    passwordHash: null,
    deactivatedAt: null,
    createdAt: new Date(),
  };
  const OTHER_ROW = { ...OWNER_ROW, id: 'u2', email: 'lee@example.com', name: 'Lee' };

  /** Every read answers with `row`; every write is recorded. */
  function fakeDb(row: typeof OWNER_ROW) {
    const updates: unknown[] = [];
    const chain = (result: unknown): Record<string, unknown> => {
      const c: Record<string, unknown> = {};
      for (const k of ['from', 'where', 'limit', 'set', 'values', 'returning', 'onConflictDoUpdate']) c[k] = () => c;
      c.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko);
      return c;
    };
    const db = {
      select: () => chain([row]),
      update: () => {
        updates.push(row.id);
        return chain([]);
      },
    } as unknown as Database;
    return { db, updates };
  }

  function makeOwnerApp(adminPassword: string, row: typeof OWNER_ROW, opts: { loginPasswordEnabled?: boolean } = {}) {
    const { db, updates } = fakeDb(row);
    const realAuth = new AuthService(db, {
      jwtSecret: 'test-jwt-secret',
      adminEmail: 'root@example.com',
      adminPassword,
      allowedEmailDomains: [],
      loginPasswordEnabled: opts.loginPasswordEnabled,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = 'second-admin';
      req.userEmail = 'second-admin@example.com';
      next();
    });
    app.use('/api', createAccountRoutes(realAuth, { isAdmin: async () => true }, accountErasure));
    return { app, updates };
  }

  const CONFIGS = [
    ['with a server-held owner password', 'sup3r-secret'],
    ['without one (the cloud)', ''],
  ] as const;

  for (const [label, adminPassword] of CONFIGS) {
    it(`refuses to switch the owner off, ${label}, and says why`, async () => {
      const { app, updates } = makeOwnerApp(adminPassword, OWNER_ROW);
      const base = await listen(app);
      const res = await fetch(`${base}/api/admin/accounts/owner/deactivate`, { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "The owner can't be switched off." });
      expect(updates).toEqual([]);
    });

    it(`switches off an account that is not the owner as today, ${label}`, async () => {
      const { app, updates } = makeOwnerApp(adminPassword, OTHER_ROW);
      const base = await listen(app);
      const res = await fetch(`${base}/api/admin/accounts/u2/deactivate`, { method: 'POST' });
      expect(res.status).toBe(204);
      expect(updates).toEqual(['u2']);
    });

    it(`deletes an account that is not the owner as today, ${label}`, async () => {
      const { app } = makeOwnerApp(adminPassword, OTHER_ROW);
      const base = await listen(app);
      const res = await fetch(`${base}/api/admin/accounts/u2`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(accountErasure.eraseUser).toHaveBeenLastCalledWith('u2');
    });

    it(`lists the owner as one, ${label}`, async () => {
      const { app } = makeOwnerApp(adminPassword, OWNER_ROW);
      const base = await listen(app);
      const body = (await (await fetch(`${base}/api/admin/accounts`)).json()) as {
        accounts: Array<{ isOwner: boolean; ownerCanBeDeleted: boolean }>;
      };
      expect(body.accounts[0]).toMatchObject({ isOwner: true, ownerCanBeDeleted: adminPassword !== '' });
    });

    it(`refuses another admin setting the owner's password, ${label}`, async () => {
      const { app } = makeOwnerApp(adminPassword, OWNER_ROW);
      const base = await listen(app);
      const res = await fetch(`${base}/api/admin/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'Root@Example.com', password: 'long-enough-pw' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/^The owner's password can't be set by another admin/);
    });
  }

  it("refuses to delete the owner's account where they could not sign back in (the cloud): nothing is erased", async () => {
    const { app } = makeOwnerApp('', OWNER_ROW);
    const base = await listen(app);
    for (const query of ['', '?removeFromAccess=1']) {
      const res = await fetch(`${base}/api/admin/accounts/owner${query}`, { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "The owner's account can't be deleted: they would have no way to sign in." });
    }
    expect(accountErasure.eraseUser).not.toHaveBeenCalled();
  });

  it('refuses it too where the server holds a password but password sign-in is off', async () => {
    const { app } = makeOwnerApp('sup3r-secret', OWNER_ROW, { loginPasswordEnabled: false });
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/owner`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(accountErasure.eraseUser).not.toHaveBeenCalled();
  });

  it("deletes the owner's account as today where they can sign back in with the server's password", async () => {
    const { app } = makeOwnerApp('sup3r-secret', OWNER_ROW);
    const base = await listen(app);
    const res = await fetch(`${base}/api/admin/accounts/owner`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(accountErasure.eraseUser).toHaveBeenLastCalledWith('owner');
  });

  it("still lets the owner's account be (re)created without a password, so an admin can restore it", async () => {
    vi.mocked(authService.createAccount).mockClear();
    const base = await listen(makeApp({ admin: true }));
    const res = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'root@example.com', name: 'Root' }),
    });
    expect(res.status).toBe(201);
    expect(authService.createAccount).toHaveBeenCalledWith('root@example.com', 'Root', undefined);
  });

  it('leaves the owner setting their own password through the same call to the service', async () => {
    vi.mocked(authService.createAccount).mockClear();
    const base = await listen(makeApp({ admin: true, email: 'root@example.com' }));
    const res = await fetch(`${base}/api/admin/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'root@example.com', password: 'long-enough-pw' }),
    });
    expect(res.status).toBe(201);
    expect(authService.createAccount).toHaveBeenCalledWith('root@example.com', undefined, 'long-enough-pw');
  });
});
