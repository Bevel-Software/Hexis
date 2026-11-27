import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import type { FileTreeEntry, IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import type { AuthService } from '../../auth/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import type { ICreatorAccess } from '../../access-model/index.js';
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
    {} as unknown as IVersionControlService,
    { emit: vi.fn() } as unknown as VersionControlEventBus,
    accessControl,
    testKbContext(),
    stubCreatorAccess,
    { isAdmin: async () => false } as unknown as IAdminAccessService,
    realDisk(),
  ));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe('GET /api/workspace — a branch that cannot be opened', () => {
  // Every server a test starts, so a test that asks twice leaves none behind.
  let servers: Server[] = [];
  afterEach(async () => {
    const started = servers;
    servers = [];
    for (const s of started) {
      // fetch's pooled keep-alive socket keeps the server open until the 5s
      // keepAliveTimeout fires; drop the idle connections so teardown is
      // immediate instead of costing five seconds a test.
      s.closeAllConnections();
      await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
    }
  });

  const get = async (
    branch: string,
    bootstrap: (branch: string) => Promise<unknown>,
  ): Promise<{ status: number; body: Record<string, unknown>; cacheControl: string | null }> => {
    const h = await makeHarness(bootstrap);
    servers.push(h.server);
    const res = await fetch(`${h.baseUrl}/api/workspace?branch=${encodeURIComponent(branch)}`);
    return {
      status: res.status,
      body: (await res.json()) as Record<string, unknown>,
      cacheControl: res.headers.get('cache-control'),
    };
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

  /**
   * A 410 sent without a caching rule is one Chromium kept, answering later
   * reads of the same address from its cache without asking the server. A
   * person who opened their own applied request (whose suggestions branch had
   * been removed) got that 410 for the branch, and their next proposal, which
   * recreates that branch under the same name, read the stored 410 back
   * instead of the recreated branch.
   */
  it('says no answer may be stored, the 410 for a deleted branch and the 200 for a recreated one alike', async () => {
    const gone = await get('suggestions/rae-u9-1234-/knowledge', async (branch) => {
      throw new RemoteBranchGoneError(branch);
    });
    expect(gone.status).toBe(410);
    expect(gone.cacheControl).toBe('no-store');

    const back = await get('suggestions/rae-u9-1234-/knowledge', async (branch) => ({
      id: encodeURIComponent(branch),
      name: branch,
      absolutePath: '/tmp/ws',
      createdAt: new Date(0).toISOString(),
      kbDirName: 'knowledge-base',
    }));
    expect(back.status).toBe(200);
    expect(back.cacheControl).toBe('no-store');
  });

  it('answers 500 — not 404 — when the remote is merely unreachable', async () => {
    const { status, body } = await get('alice/draft', async () => {
      throw new Error('Failed to clone process map: fatal: Could not resolve host: github.com');
    });

    expect(status).toBe(500);
    expect(body.kind).toBeUndefined();
  });
});
