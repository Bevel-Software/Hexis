import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createConnectionKeysAdminRoutes } from '../connection-keys-admin.routes.js';
import { TokenNotFoundError } from '../external-api-key.errors.js';
import type { AdminExternalApiKeySummary } from '../external-api-key.interface.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

const ALICE_KEY: AdminExternalApiKeySummary = {
  id: 'tok-1',
  label: 'CI pipeline',
  kind: 'key',
  createdAt: Date.UTC(2026, 0, 1),
  lastUsedAt: Date.UTC(2026, 0, 2),
  revokedAt: null,
  user: { id: 'u-alice', email: 'alice@example.com', name: 'Alice' },
};

const keys = {
  listForDeployment: vi.fn(async () => [ALICE_KEY]),
  revokeAny: vi.fn<(id: string) => Promise<void>>(async () => {}),
};

function makeApp(opts: { admin: boolean }) {
  const adminAccess: IAdminAccessService = {
    isAdmin: vi.fn(async () => opts.admin),
  };
  const app = express();
  app.use(express.json());
  // Stand-in auth middleware: stamps the caller identity the way the real JWT
  // middleware does.
  app.use((req, _res, next) => {
    req.userId = 'u-admin';
    req.userEmail = 'admin@example.com';
    next();
  });
  app.use('/api', createConnectionKeysAdminRoutes(keys, adminAccess));
  return app;
}

let server: Server;
afterEach(() => {
  server?.close();
  keys.listForDeployment.mockClear().mockResolvedValue([ALICE_KEY]);
  keys.revokeAny.mockClear().mockResolvedValue(undefined);
});

async function listen(app: express.Express): Promise<string> {
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('connection-keys admin routes', () => {
  it('refuses non-admins on both endpoints without touching the service', async () => {
    const base = await listen(makeApp({ admin: false }));
    expect((await fetch(`${base}/api/admin/connection-keys`)).status).toBe(403);
    expect(
      (await fetch(`${base}/api/admin/connection-keys/tok-1`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect(keys.listForDeployment).not.toHaveBeenCalled();
    expect(keys.revokeAny).not.toHaveBeenCalled();
  });

  it('lists every key with its owner for admins', async () => {
    const base = await listen(makeApp({ admin: true }));
    const res = await fetch(`${base}/api/admin/connection-keys`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: AdminExternalApiKeySummary[] };
    expect(body.keys).toEqual([ALICE_KEY]);
  });

  it('revokes any key by id for admins (not scoped to the caller)', async () => {
    const base = await listen(makeApp({ admin: true }));
    const res = await fetch(`${base}/api/admin/connection-keys/tok-1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'revoked' });
    expect(keys.revokeAny).toHaveBeenCalledWith('tok-1');
  });

  it('404s an unknown key and 500s with a generic body on other failures', async () => {
    const base = await listen(makeApp({ admin: true }));
    keys.revokeAny.mockRejectedValueOnce(new TokenNotFoundError());
    expect(
      (await fetch(`${base}/api/admin/connection-keys/ghost`, { method: 'DELETE' })).status,
    ).toBe(404);

    keys.revokeAny.mockRejectedValueOnce(new Error('relation "api_tokens" does not exist'));
    const res = await fetch(`${base}/api/admin/connection-keys/tok-1`, { method: 'DELETE' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Failed to revoke this key');
    expect(JSON.stringify(body)).not.toContain('relation');

    keys.listForDeployment.mockRejectedValueOnce(new Error('boom'));
    const list = await fetch(`${base}/api/admin/connection-keys`);
    expect(list.status).toBe(500);
    expect(((await list.json()) as { error: string }).error).toBe('Failed to load connection keys');
  });
});
