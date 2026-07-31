import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ICreatorAccess } from '../../access/creator-access.js';
import type { WorkspaceService } from '../workspace.service.js';

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

interface Harness {
  server: Server;
  baseUrl: string;
  workspaceDir: string;
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
    'knowledge-base',
    stubCreatorAccess,
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error(`Unexpected server.address() shape: ${JSON.stringify(addr)}`);
  }
  const port = (addr as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}`, workspaceDir };
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
    await fs.mkdir(path.join(h.workspaceDir, 'parent/sub/deep'), { recursive: true });
    await fs.mkdir(path.join(h.workspaceDir, 'parent/other'), { recursive: true });
    await fs.writeFile(path.join(h.workspaceDir, 'parent/sub/a.md'), 'a');
    await fs.writeFile(path.join(h.workspaceDir, 'parent/sub/deep/b.md'), 'b');
    await fs.writeFile(path.join(h.workspaceDir, 'parent/other/c.md'), 'c');

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent('parent')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number };
    expect(body.status).toBe('deleted');
    expect(body.count).toBe(3);
    // The whole subtree — including the empty sub-folder shells — is gone.
    expect(await exists(path.join(h.workspaceDir, 'parent'))).toBe(false);
  });

  it('removes a folder that contains only empty sub-folders (no tracked files)', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.workspaceDir, 'parent/emptyA/nested'), { recursive: true });
    await fs.mkdir(path.join(h.workspaceDir, 'parent/emptyB'), { recursive: true });

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WORKSPACE_ID}/file?path=${encodeURIComponent('parent')}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number };
    expect(body.count).toBe(0);
    expect(await exists(path.join(h.workspaceDir, 'parent'))).toBe(false);
  });
});
