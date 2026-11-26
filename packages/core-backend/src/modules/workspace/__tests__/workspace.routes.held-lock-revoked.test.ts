import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthUser } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { FileLockService } from '../../version-control/file-lock.service.js';
import { VersionControlEventBus } from '../../version-control/event-bus.js';
import { VersionControlService } from '../../version-control/version-control.service.js';
import { makeFakeLockDb } from '../../version-control/__tests__/fake-file-lock-db.js';
import type { GitService } from '../../version-control/git/git.service.js';
import type { PullRequestService } from '../../version-control/git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../../version-control/change-request-review/change-request-review.interface.js';
import type { PendingCommitsService } from '../../version-control/pending-commits.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IChangeReadGate, ICreatorAccess } from '../../access-model/index.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../workspace.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';

/**
 * QA's bug B3 on v0.35.0, over REST: a Business user holds write on
 * `QA-Edit/`, opens `QA-Edit/notes.md` and clicks Edit (the lock is taken).
 * The admin rewrites `QA-Edit/access.md` without the grant. The user saves.
 * The save used to answer 200 and commit, because the route trusted the held
 * lock and the write gate ran only at the acquire.
 *
 * The route here runs against the REAL version-control service and the real
 * lock service (over the in-memory lock table), with the access answer flipped
 * between Edit and Save, so what decides is the code that ships.
 */

const KB = 'knowledge-base';
// A protected branch in the backend test config: the write gate applies.
const WS = 'target-company-state';
const FILE = `${KB}/QA-Edit/notes.md`;
const ORIGINAL = '# Notes\nAs it was.\n';
const USER: AuthUser = { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com', name: 'Business User' };

let root: string;
let server: Server;
let baseUrl: string;
let writable: boolean;
let locks: FileLockService;
let svc: VersionControlService;
let enqueue: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-held-lock-revoked-'));
  await fs.mkdir(path.join(root, KB, 'QA-Edit'), { recursive: true });
  await fs.writeFile(path.join(root, FILE), ORIGINAL);
  writable = true;
  locks = new FileLockService(makeFakeLockDb().db);
  enqueue = vi.fn(async () => undefined);
  const gate: IChangeReadGate = { judge: vi.fn(), assertMayChange: vi.fn(async () => undefined) };
  svc = new VersionControlService(
    {} as never,
    {} as GitService,
    {} as PullRequestService,
    {} as IChangeRequestReviewService,
    {} as WorkspaceService,
    {
      canWriteBatchAtRef: vi.fn(async (_w: string, _r: string, _e: string, paths: string[]) =>
        new Map(paths.map((p) => [p, writable])),
      ),
      eligibleWritersAtRef: vi.fn(async () => ({ roles: ['Admin'], users: [] })),
      canRestorePlatformFile: vi.fn(async () => false),
    } as unknown as IAccessControl,
    locks,
    { enqueue } as unknown as PendingCommitsService,
    testKbContext({ kbDirName: KB }),
    gate,
    new VersionControlEventBus(),
  );
  const workspaceService = {
    getWorkspacePath: async () => root,
    withPathTurn: async (_id: string, _p: string, op: () => Promise<unknown>) => op(),
    writeFile: async (_id: string, p: string, content: string) => {
      await fs.writeFile(path.join(root, p), content);
    },
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
      svc,
      { emit: vi.fn() } as unknown as VersionControlEventBus,
      { canRead: async () => true } as unknown as IAccessControl,
      testKbContext({ kbDirName: KB }),
      { planForCreate: async () => null, noteAccessFileWritten: () => {} } as unknown as ICreatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      new NodeFs(),
    ),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

function save(content: string): Promise<Response> {
  return fetch(`${baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(FILE)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

const onDisk = () => fs.readFile(path.join(root, FILE), 'utf8');

describe('PUT /file by the holder of the editor lock', () => {
  it('lands while the holder may still write, and leaves the lock for the editor to release', async () => {
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);

    const res = await save('# Notes\nEdited.\n');

    expect(res.status).toBe(200);
    expect(await onDisk()).toBe('# Notes\nEdited.\n');
    expect((await locks.get(WS, WS, FILE))?.holderUserId).toBe(USER.id);
  });

  it('is refused with the same 403 as a non-writer once write is revoked, writes nothing, and loses the lock', async () => {
    // A non-writer who never held the lock: the refusal to match.
    writable = false;
    const nonWriter = await save('# Notes\nNever.\n');
    const nonWriterBody = await nonWriter.json();
    expect(nonWriter.status).toBe(403);

    // Edit and save while granted, then the admin removes the grant.
    writable = true;
    expect((await svc.acquireLock(WS, WS, FILE, USER)).acquired).toBe(true);
    expect((await save('# Notes\nSaved while granted.\n')).status).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
    writable = false;

    const res = await save('# Notes\nTyped after the revoke.\n');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(nonWriterBody);
    // The bytes saved while the grant stood stay, and are queued to commit
    // under the holder's name; the bytes typed after the revoke never land.
    expect(await onDisk()).toBe('# Notes\nSaved while granted.\n');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ path: FILE, authorEmail: USER.email }));
    expect(await locks.get(WS, WS, FILE)).toBeNull();

    // And again, now holding nothing: the plain non-writer refusal.
    const again = await save('# Notes\nStill no.\n');
    expect(again.status).toBe(403);
    expect(await onDisk()).toBe('# Notes\nSaved while granted.\n');
  });
});
