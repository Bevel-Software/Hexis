import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { AuthService } from '../../auth/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { AccessDeniedError, type ICreatorAccess } from '../../access-model/index.js';
import type { WorkspaceService } from '../workspace.service.js';
import { VersionControlValidationError } from '../../../shared/domain-errors.js';

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

/**
 * Contract test for DELETE /workspace/:id/file on a *directory* target —
 * the recursive folder-delete branch.
 *
 * BEVA-132: deleting a folder that contains sub-folders left the (now-empty)
 * sub-directory shells on disk, so the explorer (which lists on-disk
 * directories, not just tracked files) kept showing the folder and it looked
 * undeletable. The route must sweep the whole empty subtree, not just the top
 * directory.
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WORKSPACE_ID = 'feature-branch';
const KB = 'knowledge-base';

interface Harness {
  server: Server;
  baseUrl: string;
  workspaceDir: string;
  /** The checkout inside it — where every path the route accepts resolves. */
  repoDir: string;
  /** Exposed so a test can assert the PATH the route handed the service. */
  deleteFileMock: ReturnType<typeof vi.fn>;
  /** Exposed so a test can make the write gate inside it refuse. */
  acquireLockMock: ReturnType<typeof vi.fn>;
  /** Exposed so a test can say the caller already holds a path. */
  getLockMock: ReturnType<typeof vi.fn>;
  /** Exposed so a test can see which releases queued a commit. */
  releaseLockMock: ReturnType<typeof vi.fn>;
  /** Exposed so a test can say the caller's hold lapsed before it was renewed. */
  heartbeatLockMock: ReturnType<typeof vi.fn>;
  eventBusEmit: ReturnType<typeof vi.fn>;
}

async function makeHarness(): Promise<Harness> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'beva132-'));

  const accessControl = {
    canWrite: vi.fn(),
    canWriteBatch: vi.fn(),
    canDownload: vi.fn(),
    eligibleWriters: vi.fn(),
    eligibleWriterEmails: vi.fn(),
    invalidate: vi.fn(),
    findEmailByHash: vi.fn(),
    canWriteAtRef: vi.fn(),
    canWriteBatchAtRef: vi.fn(),
    eligibleWritersAtRef: vi.fn(),
    eligibleWritersForPathsAtRef: vi.fn(),
  } as unknown as IAccessControl;

  // deleteFile just removes the file from disk — the lock/commit machinery is
  // mocked out, so the on-disk effect of a per-file delete is all that the
  // recursive-cleanup logic under test reacts to.
  const workspaceServiceMock: Partial<WorkspaceService> = {
    getWorkspacePath: vi.fn(async () => workspaceDir),
    withFolderTurn: async <T>(_id: string, _dir: string, op: () => Promise<T>) => op(),
    deleteFile: vi.fn(async (_id: string, relPath: string) => {
      await fs.rm(path.resolve(workspaceDir, relPath));
    }),
    moveEntry: vi.fn(async (_id: string, from: string, to: string) => {
      await fs.rename(path.resolve(workspaceDir, from), path.resolve(workspaceDir, to));
    }) as unknown as WorkspaceService['moveEntry'],
  };
  const workspaceService = workspaceServiceMock as WorkspaceService;

  const versionControlServiceMock: Partial<IVersionControlService> = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: {} as never })),
    releaseLock: vi.fn(async () => undefined as never),
    releaseLockNoCommit: vi.fn(async () => undefined as never),
    heartbeatLock: vi.fn(async () => ({}) as never),
  };
  const versionControlService = versionControlServiceMock as unknown as IVersionControlService;

  const authServiceMock: Partial<AuthService> = {
    getUserById: vi.fn(async () => USER),
  };
  const authService = authServiceMock as AuthService;

  const eventBus = { emit: vi.fn() } as unknown as VersionControlEventBus;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as any).userId = USER_ID;
    next();
  });
  app.use('/api', createWorkspaceRoutes(
    workspaceService,
    authService,
    versionControlService,
    eventBus,
    accessControl,
    testKbContext({ kbDirName: KB }),
    stubCreatorAccess,
    // Not exercised here — only `.bevelignore`'s tree visibility consults it.
    { isAdmin: async () => false } as unknown as IAdminAccessService,
    // The directory walk, from the fixture that stands in for the composition root.
    realDisk(),
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`Unexpected server.address() shape: ${JSON.stringify(addr)}`);
  }
  const port = (addr as AddressInfo).port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    workspaceDir,
    repoDir: path.join(workspaceDir, KB),
    deleteFileMock: workspaceServiceMock.deleteFile as unknown as ReturnType<typeof vi.fn>,
    acquireLockMock: versionControlServiceMock.acquireLock as unknown as ReturnType<typeof vi.fn>,
    getLockMock: versionControlServiceMock.getLock as unknown as ReturnType<typeof vi.fn>,
    releaseLockMock: versionControlServiceMock.releaseLock as unknown as ReturnType<typeof vi.fn>,
    heartbeatLockMock: versionControlServiceMock.heartbeatLock as unknown as ReturnType<typeof vi.fn>,
    eventBusEmit: (eventBus as unknown as { emit: ReturnType<typeof vi.fn> }).emit,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('DELETE /workspace/:id/file — recursive folder delete (BEVA-132)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await closeServer(h.server);
      await fs.rm(h.workspaceDir, { recursive: true, force: true });
    }
    h = null;
  });

  it('removes a folder whose children are sub-folders (nested files) off disk', async () => {
    h = await makeHarness();
    // parent/
    //   sub/a.md
    //   sub/deep/b.md
    //   other/c.md
    await fs.mkdir(path.join(h.repoDir, 'parent/sub/deep'), { recursive: true });
    await fs.mkdir(path.join(h.repoDir, 'parent/other'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'parent/sub/a.md'), 'a');
    await fs.writeFile(path.join(h.repoDir, 'parent/sub/deep/b.md'), 'b');
    await fs.writeFile(path.join(h.repoDir, 'parent/other/c.md'), 'c');

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent('parent')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number };
    expect(body.status).toBe('deleted');
    expect(body.count).toBe(3);
    // The whole subtree — including the empty sub-folder shells — is gone.
    expect(await exists(path.join(h.repoDir, 'parent'))).toBe(false);
  });

  it('removes a folder that contains only empty sub-folders (no tracked files)', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'parent/emptyA/nested'), { recursive: true });
    await fs.mkdir(path.join(h.repoDir, 'parent/emptyB'), { recursive: true });

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent('parent')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number };
    expect(body.count).toBe(0);
    expect(await exists(path.join(h.repoDir, 'parent'))).toBe(false);
  });
});

describe('DELETE /workspace/:id/file — one file identity', () => {
  it('deletes the canonical path, whichever accepted spelling was sent', async () => {
    // The version-control lock row is keyed by this path, so a delete spelled
    // `.//note.md` must not coordinate separately from a save on `note.md`.
    const h = await makeHarness();
    try {
      await fs.mkdir(h.repoDir, { recursive: true });
      await fs.writeFile(path.join(h.repoDir, 'note.md'), 'bye', 'utf-8');

      const res = await fetch(
        `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent('.//note.md')}`,
        { method: 'DELETE' },
      );

      expect(res.status).toBe(200);
      // One identity, and it is the REPOSITORY path: the spelling is collapsed
      // and the checkout folder added, so the lock row a delete takes is the one
      // a save on the same file takes.
      expect(h.deleteFileMock).toHaveBeenCalledWith(WORKSPACE_ID, `${KB}/note.md`);
    } finally {
      await closeServer(h.server);
      await fs.rm(h.workspaceDir, { recursive: true, force: true });
    }
  });
});

/**
 * The root's `access.md` and `roles.yaml` govern the whole repository, so the
 * app's delete route refuses them — with the sentence `delete_file` and the
 * explorer use — before a lock is taken. A nested `access.md` is a file like
 * any other here: the lock gate decides whether the caller may write it.
 */
describe('DELETE /workspace/:id/file — the repository\'s own files', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await closeServer(h.server);
      await fs.rm(h.workspaceDir, { recursive: true, force: true });
    }
    h = null;
  });

  const del = (base: string, p: string) =>
    fetch(`${base}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });

  it.each(['access.md', 'roles.yaml'])('refuses the root %s with one sentence and leaves it', async (name) => {
    h = await makeHarness();
    await fs.mkdir(h.repoDir, { recursive: true });
    await fs.writeFile(path.join(h.repoDir, name), 'x', 'utf-8');

    const res = await del(h.baseUrl, name);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: `${name} is the repository's own file and cannot be deleted.` });
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    expect(await exists(path.join(h.repoDir, name))).toBe(true);
  });

  it('deletes a nested access.md like any file, and a nested roles.yaml too', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/access.md'), '---\nread: Admin\n---\n', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/roles.yaml'), 'content', 'utf-8');
    // Not emptied by these deletes, so no placeholder needs keeping.
    await fs.writeFile(path.join(h.repoDir, 'Team/notes.md'), 'n', 'utf-8');

    for (const p of ['Team/access.md', 'Team/roles.yaml']) {
      const res = await del(h.baseUrl, p);
      expect(res.status).toBe(200);
      expect(h.deleteFileMock).toHaveBeenCalledWith(WORKSPACE_ID, `${KB}/${p}`);
      expect(await exists(path.join(h.repoDir, p))).toBe(false);
    }
  });

  it('refuses a nested access.md with the ordinary write refusal when the caller may not write it', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/access.md'), '---\nwrite: Admin\n---\n', 'utf-8');
    // The write gate lives inside `acquireLock`; it refuses as it does for any file.
    const refusal = new AccessDeniedError({ path: 'Team/access.md', eligibleRoles: ['Admin'], eligibleUsers: [] });
    h.acquireLockMock.mockRejectedValueOnce(refusal);

    const res = await del(h.baseUrl, 'Team/access.md');

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(refusal.message);
    expect(body.error).not.toContain('platform file');
    expect(body.error).not.toContain("repository's own file");
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    expect(await exists(path.join(h.repoDir, 'Team/access.md'))).toBe(true);
  });

  it('refuses a reserved top-level folder as delete_folder does, and leaves what it holds', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'KnowledgeBase/Product'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'KnowledgeBase/Product/Plan.md'), 'p', 'utf-8');

    const res = await del(h.baseUrl, `${KB}/KnowledgeBase`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'KnowledgeBase/ is a platform folder and cannot be moved or deleted.' });
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    expect(await exists(path.join(h.repoDir, 'KnowledgeBase/Product/Plan.md'))).toBe(true);
  });

  it.each([KB, `${KB}/`])('refuses the repository root as a folder (%j) and leaves its own files', async (p) => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'access.md'), 'x', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'roles.yaml'), 'x', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/notes.md'), 'n', 'utf-8');

    const res = await del(h.baseUrl, p);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The repository root is a platform folder and cannot be moved or deleted.' });
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    for (const f of ['access.md', 'roles.yaml', 'Team/notes.md']) {
      expect(await exists(path.join(h.repoDir, f))).toBe(true);
    }
  });
});

/**
 * A removal made while the caller already holds the path's lock — the editor
 * took it for a save that is still on its way — used to run "inside" that
 * hold and leave the commit to the holder's own release. The file is gone,
 * so that release never came (the tab closed, the hold expired, the save was
 * refused): the deletion stayed on disk with nothing queued to commit it, and
 * the repository kept the file. A removal ends the edit, so it is committed
 * by the request that made it, held or not.
 */
describe('DELETE and move under the caller\'s own hold — the removal is committed', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await closeServer(h.server);
      await fs.rm(h.workspaceDir, { recursive: true, force: true });
    }
    h = null;
  });

  const heldBy = (id: string, name = 'Alice') => ({ holderUserId: id, holderName: name });
  const holdOnly = (held: string[]) => async (_ws: string, _branch: string, p: string) =>
    held.includes(p) ? heldBy(USER_ID) : null;
  const del = (base: string, p: string) =>
    fetch(`${base}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
  const lockNotHeld = () =>
    new VersionControlValidationError('Cannot release lock: not held by you (or no longer exists).', {
      kind: 'lock-not-held',
    });
  const releasedPaths = () => h!.releaseLockMock.mock.calls.map((c) => c[2]);

  it('queues the deletion of a file the caller holds, without taking a second hold', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Draft.md`]));

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'Team/Draft.md'))).toBe(false);
    expect(releasedPaths()).toEqual([`${KB}/Team/Draft.md`]);
    expect(h.acquireLockMock).not.toHaveBeenCalled();
    expect(h.eventBusEmit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fs-tree-changed' }));
  });

  it('takes a fresh hold to queue the deletion when the caller\'s hold ended before its release', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Draft.md`]));
    h.releaseLockMock.mockRejectedValueOnce(lockNotHeld());

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(200);
    expect(h.acquireLockMock).toHaveBeenCalledWith(WORKSPACE_ID, WORKSPACE_ID, `${KB}/Team/Draft.md`, USER);
    expect(releasedPaths()).toEqual([`${KB}/Team/Draft.md`, `${KB}/Team/Draft.md`]);
  });

  it('answers 409 naming the new holder, not success, when someone else took the path before the deletion was queued', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Draft.md`]));
    h.releaseLockMock.mockRejectedValueOnce(lockNotHeld());
    h.acquireLockMock.mockResolvedValueOnce({ acquired: false, lock: heldBy('user-2', 'Bob') });

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('Bob started editing it before the deletion was shared');
    expect(releasedPaths()).toEqual([`${KB}/Team/Draft.md`]);
  });

  it('passes on a release failure that is not an ended hold', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Draft.md`]));
    h.releaseLockMock.mockRejectedValueOnce(new Error('queue unavailable'));

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(500);
    expect(h.acquireLockMock).not.toHaveBeenCalled();
  });

  it('queues the deletion of a held file inside a deleted folder, with the folder\'s other files', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team/Old'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Old/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Old/Other.md'), 'other', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Old/Draft.md`]));

    const res = await del(h.baseUrl, 'Team/Old');

    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'Team/Old'))).toBe(false);
    expect(releasedPaths().sort()).toEqual([`${KB}/Team/Old/Draft.md`, `${KB}/Team/Old/Other.md`]);
  });

  it('queues the source side of a move the caller holds', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Draft.md`]));

    const res = await fetch(`${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'Team/Draft.md', newPath: 'Team/Final.md' }),
    });

    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'Team/Final.md'))).toBe(true);
    expect(releasedPaths().sort()).toEqual([`${KB}/Team/Draft.md`, `${KB}/Team/Final.md`]);
  });

  it('still leaves the release of a held path the op keeps to its holder', async () => {
    // The destination of a move is written, not removed: a hold the caller
    // has there stays theirs to release, as a save under the editor's hold does.
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
    h.getLockMock.mockImplementation(holdOnly([`${KB}/Team/Final.md`]));

    const res = await fetch(`${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: 'Team/Draft.md', newPath: 'Team/Final.md' }),
    });

    expect(res.status).toBe(200);
    expect(releasedPaths()).toEqual([`${KB}/Team/Draft.md`]);
  });
});

/**
 * The caller's hold is read once, and can lapse before the removal runs: a
 * hold that ended may already be someone else's. Everything that can refuse
 * the removal is decided BEFORE the file is touched, so another editor never
 * loses a file to a request that then answers 409.
 */
describe('DELETE under the caller\'s own hold — refused before anything is removed', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) {
      await closeServer(h.server);
      await fs.rm(h.workspaceDir, { recursive: true, force: true });
    }
    h = null;
  });

  const del = (base: string, p: string) =>
    fetch(`${base}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
  const lockNotHeld = () =>
    new VersionControlValidationError('Cannot heartbeat lock: not held by you (or no longer exists).', {
      kind: 'lock-not-held',
    });
  const seed = async (hh: Harness) => {
    await fs.mkdir(path.join(hh.repoDir, 'Team'), { recursive: true });
    await fs.writeFile(path.join(hh.repoDir, 'Team/Draft.md'), 'draft', 'utf-8');
    await fs.writeFile(path.join(hh.repoDir, 'Team/Keep.md'), 'keep', 'utf-8');
  };
  const DRAFT = `${KB}/Team/Draft.md`;

  it('renews the caller\'s hold before the removal runs', async () => {
    h = await makeHarness();
    await seed(h);
    h.getLockMock.mockImplementation(async (_w: string, _b: string, p: string) =>
      p === DRAFT ? { holderUserId: USER_ID, holderName: 'Alice', mode: 'edit' } : null,
    );

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(200);
    expect(h.heartbeatLockMock).toHaveBeenCalledWith(WORKSPACE_ID, WORKSPACE_ID, DRAFT, USER);
    const renewedAt = h.heartbeatLockMock.mock.invocationCallOrder[0];
    const removedAt = h.deleteFileMock.mock.invocationCallOrder[0];
    expect(renewedAt).toBeLessThan(removedAt);
  });

  it('answers 409 naming the new holder and leaves the file when the hold lapsed to someone else', async () => {
    h = await makeHarness();
    await seed(h);
    h.getLockMock.mockImplementation(async (_w: string, _b: string, p: string) =>
      p === DRAFT ? { holderUserId: USER_ID, holderName: 'Alice', mode: 'edit' } : null,
    );
    h.heartbeatLockMock.mockRejectedValueOnce(lockNotHeld());
    h.acquireLockMock.mockResolvedValueOnce({ acquired: false, lock: { holderUserId: 'user-2', holderName: 'Bob' } });

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('being edited by Bob');
    expect(await exists(path.join(h.repoDir, 'Team/Draft.md'))).toBe(true);
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    expect(h.releaseLockMock).not.toHaveBeenCalled();
  });

  it('takes the path as an unheld removal does when the hold lapsed and nobody took it', async () => {
    h = await makeHarness();
    await seed(h);
    h.getLockMock.mockImplementation(async (_w: string, _b: string, p: string) =>
      p === DRAFT ? { holderUserId: USER_ID, holderName: 'Alice', mode: 'edit' } : null,
    );
    h.heartbeatLockMock.mockRejectedValueOnce(lockNotHeld());

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'Team/Draft.md'))).toBe(false);
    expect(h.acquireLockMock.mock.invocationCallOrder[0]).toBeLessThan(h.deleteFileMock.mock.invocationCallOrder[0]);
    expect(h.releaseLockMock.mock.calls.map((c) => c[2])).toEqual([DRAFT]);
  });

  it('refuses with 409 and leaves the file under the caller\'s own coordination hold', async () => {
    h = await makeHarness();
    await seed(h);
    h.getLockMock.mockImplementation(async (_w: string, _b: string, p: string) =>
      p === DRAFT ? { holderUserId: USER_ID, holderName: 'Alice', mode: 'coordination' } : null,
    );

    const res = await del(h.baseUrl, 'Team/Draft.md');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('held for coordination');
    expect(await exists(path.join(h.repoDir, 'Team/Draft.md'))).toBe(true);
    expect(h.deleteFileMock).not.toHaveBeenCalled();
    expect(h.releaseLockMock).not.toHaveBeenCalled();
    expect(h.heartbeatLockMock).not.toHaveBeenCalled();
  });
});
