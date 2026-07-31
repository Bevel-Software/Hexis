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
import type { Database } from '../../database/connection.js';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { createAccessRoutes } from '../access.routes.js';

/**
 * HTTP-level contract tests for the /api/access/roles routes: the admin gate
 * (non-admin → 403), the GET roster shape, and that service-layer invariant
 * errors (reserved name → 422, self-admin-removal → 409 { kind }) surface with
 * the right status. The CRUD logic itself is covered by roles-admin.service.test;
 * here we pin the route wiring + error mapping.
 */

const KB = 'knowledge-base';
const ADMIN = { id: 'u-admin', email: 'razvan@bevel.software', name: 'Razvan' };

const ROLES = `roles:
  Admin:
    - razvan@bevel.software
    - juan@bevel.software
  Sales:
    - felix@example.com
`;

/** Temp workspace dirs to clean up after each test. */
const tmpDirs: string[] = [];

async function makeHarness(opts: { isAdmin?: boolean } = {}): Promise<{ server: Server; baseUrl: string }> {
  const isAdmin = opts.isAdmin ?? true;

  // Back the harness with a REAL temp workspace dir: the service's single-file
  // path writes through a real LockingFilesystem (LocalFilesystem → disk under
  // getWorkspacePath), so an in-memory map would never see the write. The repo
  // lives at <workspaceDir>/<KB>, mirroring production layout.
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-roles-routes-'));
  tmpDirs.push(workspaceDir);
  const repoDir = path.join(workspaceDir, KB);
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'roles.yaml'), ROLES, 'utf-8');

  // The roles routes gate on canWrite(..., 'roles.yaml'); the service reads the
  // real file and edits it, but for these route tests we only need GET + error
  // mapping, so a lightweight access stub backed by the real parser is enough.
  const { AccessControlService } = await import('../access-control.service.js');
  const realAccess = new AccessControlService(
    { getWorkspacePath: async () => workspaceDir, readFile: async () => ROLES } as unknown as WorkspaceService,
    KB,
  );
  const accessControl = {
    // Admin gate: the route's assertCanMutate calls canWrite('roles.yaml').
    canWrite: vi.fn(async () => isAdmin),
    eligibleWriters: vi.fn(async () => ({ roles: ['Admin'], users: [] })),
    invalidate: vi.fn(),
    validateRolesYaml: (t: string) => realAccess.validateRolesYaml(t),
    referencesToRole: vi.fn(async () => []),
  } as unknown as IAccessControl;

  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  // Workspace-rooted file tree (paths workspace-relative, skipping `.git`) — the
  // candidate source getRoster's reference scan walks. No `.md` in this fixture,
  // so the scan finds nothing, which is what these route tests expect.
  const buildTree = async (absDir: string): Promise<FileTreeEntry> => {
    const rel = path.relative(workspaceDir, absDir).replace(/\\/g, '/');
    const children: FileTreeEntry[] = [];
    for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) children.push(await buildTree(childAbs));
      else if (e.isFile()) {
        children.push({
          name: e.name,
          relativePath: path.relative(workspaceDir, childAbs).replace(/\\/g, '/'),
          type: 'file',
        });
      }
    }
    return { name: path.basename(absDir), relativePath: rel || '.', type: 'directory', children };
  };
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({})),
    getWorkspacePath: vi.fn(async () => workspaceDir),
    listFiles: vi.fn(async () => buildTree(workspaceDir)),
    readFile: vi.fn(async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8')),
    writeFile: vi.fn(async (_id: string, wsRel: string, c: string) => {
      await fs.mkdir(path.dirname(resolve(wsRel)), { recursive: true });
      await fs.writeFile(resolve(wsRel), c, 'utf-8');
    }),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => ADMIN) } as unknown as AuthService;

  // Lock holder tracked so the service's getLock pre-check passes; the single-
  // file write itself lands on disk via LockingFilesystem → LocalFilesystem.
  let holder: { id: string; name: string } | null = null;
  const lockRow = (h: { id: string; name: string }) => ({ holderUserId: h.id, holderName: h.name });
  const workflowService = {
    getLock: vi.fn(async () => (holder ? lockRow(holder) : null)),
    acquireLock: vi.fn(async (_w: string, _b: string, _p: string, user: { id: string; name: string }) =>
      holder && holder.id !== user.id
        ? { acquired: false, lock: lockRow(holder) }
        : ((holder = user), { acquired: true, lock: lockRow(user) }),
    ),
    releaseLock: vi.fn(async () => void (holder = null)),
    releaseLockNoCommit: vi.fn(async () => void (holder = null)),
    // Write-free: the lock-aware filesystem writes to disk; this just commits the
    // dirty tree. Not exercised by these route tests (no rename), but kept honest.
    commitChanges: vi.fn(async () => ({})),
  } as unknown as WorkflowService;

  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const db = {} as unknown as Database;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = ADMIN.id;
    next();
  });
  app.use('/api', createAccessRoutes(accessControl, workspaceService, authService, workflowService, eventBus, db, KB));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('/api/access/roles routes', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) await close(server);
    server = null;
    await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('GET returns the roster with Admin marked', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/access/roles`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: { canonical: string; isAdmin: boolean }[] };
    expect(body.roles.map((r) => r.canonical)).toEqual(['admin', 'sales']);
    expect(body.roles.find((r) => r.canonical === 'admin')!.isAdmin).toBe(true);
  });

  it('a non-admin is refused on GET roster too — roster is admin-only (CodeRabbit)', async () => {
    const h = await makeHarness({ isAdmin: false });
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/access/roles`);
    expect(res.status).toBe(403);
  });

  it('a non-admin is refused on every mutating route (403)', async () => {
    const h = await makeHarness({ isAdmin: false });
    server = h.server;
    const post = await fetch(`${h.baseUrl}/api/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Marketing' }),
    });
    expect(post.status).toBe(403);
    const del = await fetch(`${h.baseUrl}/api/access/roles/sales`, { method: 'DELETE' });
    expect(del.status).toBe(403);
  });

  it('create with a reserved name → 422', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'everyone' }),
    });
    expect(res.status).toBe(422);
  });

  it('delete Admin → 422', async () => {
    const h = await makeHarness();
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/access/roles/admin`, { method: 'DELETE' });
    expect(res.status).toBe(422);
  });

  it('removing own last Admin membership → 409 { kind: self-admin-removal }', async () => {
    const h = await makeHarness();
    server = h.server;
    // Remove the OTHER admin first so razvan is the only one, then razvan
    // removing himself trips the last-member guard (422). To hit the 409
    // self-removal path we remove juan (razvan removing juan is not self) —
    // instead razvan removing himself while juan remains is the self case:
    const res = await fetch(
      `${h.baseUrl}/api/access/roles/admin/members/${encodeURIComponent('razvan@bevel.software')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { kind?: string };
    expect(body.kind).toBe('self-admin-removal');
  });

  it('create a role then add a member → 200 fresh roster', async () => {
    const h = await makeHarness();
    server = h.server;
    const created = await fetch(`${h.baseUrl}/api/access/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Marketing' }),
    });
    expect(created.status).toBe(200);
    const add = await fetch(`${h.baseUrl}/api/access/roles/marketing/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mkt@example.com' }),
    });
    expect(add.status).toBe(200);
    const body = (await add.json()) as { roles: { canonical: string; members: string[] }[] };
    expect(body.roles.find((r) => r.canonical === 'marketing')!.members).toContain('mkt@example.com');
  });
});
