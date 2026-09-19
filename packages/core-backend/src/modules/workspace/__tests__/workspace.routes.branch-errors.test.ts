import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { FileTreeEntry, IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkspaceService } from '../workspace.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { BranchNotFoundError, RemoteBranchGoneError } from '../../../shared/domain-errors.js';

const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

const emptyTree: FileTreeEntry = { name: 'knowledge-base', path: '', type: 'directory', children: [] };

/**
 * `GET /api/workspace` is where a browser learns that the branch in its URL
 * cannot be opened, and the status it answers is the whole of what the file
 * page has to go on. The two refusals must stay apart on the wire: 404
 * `branch-not-found` for a name the platform never knew, 410
 * `remote-branch-gone` for one it did.
 */
async function makeHarness(
  getOrCreateForBranch: (branch: string) => Promise<unknown>,
): Promise<{ server: Server; baseUrl: string }> {
  const workspaceService = {
    getOrCreateForBranch: vi.fn(getOrCreateForBranch),
    listFiles: vi.fn(async () => emptyTree),
  } as unknown as WorkspaceService;

  const accessControl = {
    canReadBatch: async (_w: string, _u: string, paths: string[]) =>
      new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = USER.id;
    next();
  });
  app.use('/api', createWorkspaceRoutes(
    workspaceService,
    { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
    {} as unknown as IWorkflowService,
    { emit: vi.fn() } as unknown as WorkflowEventBus,
    accessControl,
    'knowledge-base',
    stubCreatorAccess,
    { isAdmin: async () => false } as unknown as IAdminAccessService,
    new NodeFs(),
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('GET /api/workspace — a branch that cannot be opened', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      const s = server;
      await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
    }
    server = null;
  });

  const get = async (
    branch: string,
    bootstrap: (branch: string) => Promise<unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const h = await makeHarness(bootstrap);
    server = h.server;
    const res = await fetch(`${h.baseUrl}/api/workspace?branch=${encodeURIComponent(branch)}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('answers 404 and names the branch when the platform has never heard of it', async () => {
    const { status, body } = await get('nobody/never-made-this', async (branch) => {
      throw new BranchNotFoundError(branch);
    });

    expect(status).toBe(404);
    expect(body).toEqual({
      kind: 'branch-not-found',
      branch: 'nobody/never-made-this',
      error: 'There is no branch named nobody/never-made-this.',
    });
  });

  it('keeps answering 410 for a branch that was deleted on the host', async () => {
    const { status, body } = await get('alice/draft', async (branch) => {
      throw new RemoteBranchGoneError(branch);
    });

    expect(status).toBe(410);
    expect(body).toMatchObject({ kind: 'remote-branch-gone', branch: 'alice/draft' });
    expect(body.error).toContain('no longer exists on the remote');
  });

  it('answers 200 with the workspace for a branch that exists', async () => {
    const { status, body } = await get('alice/draft', async (branch) => ({
      id: encodeURIComponent(branch),
      name: branch,
      absolutePath: '/tmp/ws',
      createdAt: new Date(0).toISOString(),
      kbDirName: 'knowledge-base',
    }));

    expect(status).toBe(200);
    expect(body).toMatchObject({ workspace: { id: 'alice%2Fdraft' } });
  });

  it('answers 500 — not 404 — when the remote is merely unreachable', async () => {
    const { status, body } = await get('alice/draft', async () => {
      throw new Error('Failed to clone process map: fatal: Could not resolve host: github.com');
    });

    expect(status).toBe(500);
    expect(body.kind).toBeUndefined();
  });
});
