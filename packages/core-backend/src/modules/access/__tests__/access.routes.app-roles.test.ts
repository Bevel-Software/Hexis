import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { AccessControlService } from '../access-control.service.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { VersionControlService } from '../../version-control/version-control.service.js';
import type { VersionControlEventBus } from '../../version-control/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * `GET /api/access/roles` with the app's roles handed to the access routes,
 * as `createCoreServer` hands `ServerExtensions.appRoles`: the roster an
 * admin reads lists the app's role, held by nobody yet, with its description.
 */

const KB = 'knowledge-base';
const ADMIN = { id: 'u-sam', email: 'sam@acme.com', name: 'Sam Admin' };
const INFRA = { displayName: 'Infrastructure Engineer', description: 'Sees and runs the executors.' };

let server: Server | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = null;
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

async function serve(appRoles: { displayName: string; description: string }[]): Promise<string> {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-app-roles-route-'));
  await fs.mkdir(path.join(dir, KB), { recursive: true });
  await fs.writeFile(path.join(dir, KB, 'roles.yaml'), `roles:\n  Admin:\n    - ${ADMIN.email}\n`, 'utf-8');
  const workspaceDir = dir;
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({})),
    getWorkspacePath: vi.fn(async () => workspaceDir),
    readFile: vi.fn(async (_id: string, wsRel: string) => fs.readFile(path.join(workspaceDir, wsRel), 'utf-8')),
  } as unknown as WorkspaceService;
  const accessControl = new AccessControlService(workspaceService, KB, new NodeFs(), []);
  const authService = { getUserById: vi.fn(async () => ADMIN) } as unknown as AuthService;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ADMIN.id;
    next();
  });
  app.use(
    '/api',
    createAccessRoutes(
      accessControl,
      workspaceService,
      authService,
      authService,
      {} as unknown as VersionControlService,
      { emit: vi.fn() } as unknown as VersionControlEventBus,
      usersDbDouble([ADMIN]),
      testKbContext({ kbDirName: KB }),
      new NodeFs(),
      [],
      appRoles,
    ),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('GET /api/access/roles with roles the app defines', () => {
  it('lists the app role nobody holds yet, after Admin, with its description', async () => {
    const base = await serve([INFRA]);
    const res = await fetch(`${base}/api/access/roles`);
    expect(res.status).toBe(200);
    const { roles } = (await res.json()) as { roles: Array<{ canonical: string; members: string[]; capability: { description: string } | null }> };
    expect(roles.map((r) => r.canonical)).toEqual(['admin', 'infrastructure engineer']);
    expect(roles[1]).toMatchObject({ members: [], capability: { description: INFRA.description } });
  });

  it('lists only core\'s roles when the app defines none', async () => {
    const base = await serve([]);
    const { roles } = (await (await fetch(`${base}/api/access/roles`)).json()) as { roles: Array<{ canonical: string }> };
    expect(roles.map((r) => r.canonical)).toEqual(['admin']);
  });
});
