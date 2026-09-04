import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createSetupRoutes, type LastSyncStatus } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { Database } from '../../database/connection.js';

/**
 * The remote-sync facts on `GET /setup/status`: the address a hook calls and
 * what the last sync did. Admin-only like the rest of the settings — a
 * non-admin learns nothing about the deployment's endpoints.
 */
const ENC_KEY = randomBytes(32).toString('base64');

let server: HttpServer | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

function listen(isAdmin: boolean, last: LastSyncStatus | null) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createSetupRoutes(
      settings,
      { isAdmin: async () => isAdmin } as IAdminAccessService,
      { runAll: async () => {} },
      { url: 'https://hexis.example.test/api/sync', lastSync: () => last },
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /setup/status — remote sync', () => {
  it('tells an admin the address and the last sync', async () => {
    const last: LastSyncStatus = {
      at: 1_700_000_000_000,
      by: 'bearer',
      status: 'synced',
      results: [{ branch: 'main', outcome: 'updated' }],
    };
    const res = await fetch(`${listen(true, last)}/api/setup/status`);
    const body = (await res.json()) as { sync?: unknown };
    expect(body.sync).toEqual({ url: 'https://hexis.example.test/api/sync', last });
  });

  it('says null before the first sync', async () => {
    const res = await fetch(`${listen(true, null)}/api/setup/status`);
    const body = (await res.json()) as { sync?: { last: unknown } };
    expect(body.sync?.last).toBeNull();
  });

  it('tells a non-admin nothing', async () => {
    const res = await fetch(`${listen(false, null)}/api/setup/status`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.sync).toBeUndefined();
    expect(body.settings).toBeUndefined();
  });
});
