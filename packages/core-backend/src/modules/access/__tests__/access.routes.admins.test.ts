import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * `GET /api/access/admins`: who the admins are, for anyone signed in. It
 * answers the Admin role's members — through a group too — and the deployment
 * admins, each once, sorted by name, with names from the accounts table; and
 * nothing else about roles. The roster stays admin-only.
 */

const KB = 'knowledge-base';
const MEMBER = { id: 'u-lena', email: 'lena@acme.com', name: 'Lena Park' };

const ROLES = `roles:
  Admin:
    - sam.ortiz@acme.com
    - group:Ops
  Sales:
    - felix@acme.com
`;

const GROUPS = `groups:
  Ops:
    - dana@acme.com
    - sam.ortiz@acme.com
  Product:
    - priya@acme.com
`;

const tmpDirs: string[] = [];

async function makeHarness(
  opts: { roles?: string; signedIn?: boolean; deploymentAdmins?: string[] } = {},
): Promise<{ server: Server; baseUrl: string }> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-admins-route-'));
  tmpDirs.push(workspaceDir);
  const repoDir = path.join(workspaceDir, KB);
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'roles.yaml'), opts.roles ?? ROLES, 'utf-8');
  await fs.writeFile(path.join(repoDir, 'groups.yaml'), GROUPS, 'utf-8');

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({})),
    getWorkspacePath: vi.fn(async () => workspaceDir),
    readFile: vi.fn(async (_id: string, wsRel: string) => fs.readFile(path.join(workspaceDir, wsRel), 'utf-8')),
  } as unknown as WorkspaceService;
  // Nobody here may read the roster: the admins read must not depend on it.
  const accessControl = {
    canWrite: vi.fn(async () => false),
    eligibleWriters: vi.fn(async () => ({ roles: ['Admin'], users: [] })),
    invalidate: vi.fn(),
  } as unknown as IAccessControl;
  const authService = { getUserById: vi.fn(async () => MEMBER) } as unknown as AuthService;
  const db = usersDbDouble([
    { email: 'dana@acme.com', name: 'Dana Admin' },
    { email: 'sam.ortiz@acme.com', name: 'Sam Ortiz' },
    { email: 'felix@acme.com', name: 'Felix Sales' },
    { email: 'priya@acme.com', name: 'Priya Product' },
    MEMBER,
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    if (opts.signedIn !== false) (req as unknown as { userId: string }).userId = MEMBER.id;
    next();
  });
  app.use(
    '/api',
    createAccessRoutes(
      accessControl,
      workspaceService,
      authService,
      {} as unknown as WorkflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      db,
      testKbContext({ kbDirName: KB }),
      opts.deploymentAdmins ?? ['Owner@Acme.com'],
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('GET /api/access/admins', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await close(server);
    server = null;
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('tells a Member every admin — direct, through a group, and the deployment admin — once each, sorted by name', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/access/admins`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      admins: [
        { name: 'Dana Admin', email: 'dana@acme.com' },
        // No account yet: named by address.
        { name: 'owner@acme.com', email: 'owner@acme.com' },
        { name: 'Sam Ortiz', email: 'sam.ortiz@acme.com' },
      ],
    });
  });

  it('reveals nothing else: no other role, group or member, and no other field', async () => {
    const h = await makeHarness();
    server = h.server;
    const text = await (await fetch(`${h.baseUrl}/api/access/admins`)).text();
    for (const leak of ['felix', 'priya', 'Sales', 'Product', 'Ops', 'group:', 'lena']) {
      expect(text).not.toContain(leak);
    }
    const body = JSON.parse(text) as { admins: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(['admins']);
    for (const admin of body.admins) expect(Object.keys(admin).sort()).toEqual(['email', 'name']);
  });

  it('answers only the deployment admins when roles.yaml does not parse, as the resolver does', async () => {
    const h = await makeHarness({ roles: 'roles:\n  Admin: not-a-list\n' });
    server = h.server;
    const body = (await (await fetch(`${h.baseUrl}/api/access/admins`)).json()) as { admins: unknown[] };
    expect(body.admins).toEqual([{ name: 'owner@acme.com', email: 'owner@acme.com' }]);
  });

  it('refuses a caller who is not signed in', async () => {
    const h = await makeHarness({ signedIn: false });
    server = h.server;
    expect((await fetch(`${h.baseUrl}/api/access/admins`)).status).toBe(401);
  });

  it('leaves the roles roster admin-only', async () => {
    const h = await makeHarness();
    server = h.server;
    expect((await fetch(`${h.baseUrl}/api/access/roles`)).status).toBe(403);
  });
});
