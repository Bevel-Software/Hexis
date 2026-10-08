import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkspaceService } from '../workspace.service.js';
import { AccessDeniedError } from '../../access-model/access-errors.js';

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
  };
  const workspaceService = workspaceServiceMock as WorkspaceService;

  const workflowServiceMock: Partial<IWorkflowService> = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: {} as never })),
    releaseLock: vi.fn(async () => undefined as never),
    releaseLockNoCommit: vi.fn(async () => undefined as never),
  };
  const workflowService = workflowServiceMock as unknown as IWorkflowService;

  const authServiceMock: Partial<AuthService> = {
    getUserById: vi.fn(async () => USER),
  };
  const authService = authServiceMock as AuthService;

  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as any).userId = USER_ID;
    next();
  });
  app.use('/api', createWorkspaceRoutes(
    workspaceService,
    authService,
    workflowService,
    eventBus,
    accessControl,
    testKbContext({ kbDirName: KB }),
    stubCreatorAccess,
    // Not exercised here — only `.bevelignore`'s tree visibility consults it.
    { isAdmin: async () => false } as unknown as IAdminAccessService,
    new NodeFs(),
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
    acquireLockMock: workflowServiceMock.acquireLock as unknown as ReturnType<typeof vi.fn>,
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
    // The workflow lock row is keyed by this path, so a delete spelled
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
