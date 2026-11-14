import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAdminAccessService } from '../../admin/index.js';
import type { GroupsAdminService } from '../groups-admin.service.js';
import { createGroupsAdminRoutes } from '../groups-admin.routes.js';

/**
 * GET /admin/groups is a read: the roster is filtered for the email the admin
 * gate checked, and a failing user lookup (needed only to attribute commits)
 * never fails it.
 */
describe('GET /admin/groups', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function start(email: string, isAdmin: boolean) {
    const getRoster = vi.fn(async (viewer: string) => ({ viewer, groups: [] }));
    const getUserById = vi.fn(async () => {
      throw new Error('users table unavailable');
    });
    const app = express();
    app.use((req, _res, next) => {
      req.userId = 'u-1';
      req.userEmail = email;
      next();
    });
    app.use(
      createGroupsAdminRoutes({
        groupsAdmin: { getRoster } as unknown as GroupsAdminService,
        adminAccess: { isAdmin: async () => isAdmin } as unknown as IAdminAccessService,
        getUserById,
      }),
    );
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/admin/groups`, getRoster, getUserById };
  }

  it('reads the roster for the gated email without a user lookup', async () => {
    const { url, getRoster, getUserById } = await start('admin@x.io', true);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ viewer: 'admin@x.io', groups: [] });
    expect(getRoster).toHaveBeenCalledWith('admin@x.io');
    expect(getUserById).not.toHaveBeenCalled();
  });

  it('still refuses a non-admin', async () => {
    const { url, getRoster } = await start('pat@x.io', false);
    expect((await fetch(url)).status).toBe(403);
    expect(getRoster).not.toHaveBeenCalled();
  });
});
