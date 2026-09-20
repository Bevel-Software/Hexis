import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowEventBus } from '../event-bus.js';
import { createWorkflowRoutes } from '../workflow.routes.js';

/**
 * The "before" side of a request dialog's diff is the file at the request's
 * fork point. It is file content like any other, so it is gated by the read
 * model of the tree it belongs to — the target's — before git is consulted.
 */

const USER = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
const SHA = 'c'.repeat(40);
const CR = { number: 7, branch: 'alice/deal', base: 'current-company-state' };

async function makeHarness() {
  const canReadAtRef = vi.fn(async (_w: string, _r: string, _e: string, p: string) =>
    p.includes('Secret') ? false : p.includes('Unknown') ? null : true,
  );
  const workflow = {
    getChangeRequest: vi.fn(async (n: number) => (n === 7 ? CR : null)),
    fileAtForkPoint: vi.fn(async () => 'price: 100\n'),
    changeRequestForkPoint: vi.fn(async (): Promise<string | null> => SHA),
  };
  const workspaceService = {
    getOrCreateForUser: vi.fn(async () => ({ id: 'ws-alice' })),
  } as unknown as WorkspaceService;
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createWorkflowRoutes(
      workflow as unknown as IWorkflowService,
      workspaceService,
      { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
      { subscribe: vi.fn(), publish: vi.fn() } as unknown as WorkflowEventBus,
      { canReadAtRef } as unknown as IAccessControl,
      'knowledge-base',
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return { server, workflow, canReadAtRef, baseUrl: `http://127.0.0.1:${port}` };
}

describe('GET /workflow/change-requests/:number/fork-point-file', () => {
  let h: Awaited<ReturnType<typeof makeHarness>> | null = null;
  afterEach(async () => {
    if (h) await new Promise<void>((r) => h!.server.close(() => r()));
    h = null;
  });
  const get = (n: number, p: string, sha = SHA) =>
    fetch(`${h!.baseUrl}/api/workflow/change-requests/${n}/fork-point-file?path=${encodeURIComponent(p)}&sha=${sha}`);

  it('serves the file at the fork point, authorized on the target branch', async () => {
    h = await makeHarness();
    const res = await get(7, 'Sales/Deal.md');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'price: 100\n', forkSha: SHA });
    expect(h.canReadAtRef).toHaveBeenCalledWith(
      'ws-alice',
      'origin/current-company-state',
      USER.email,
      'Sales/Deal.md',
    );
    expect(h.workflow.fileAtForkPoint).toHaveBeenCalledWith(
      'ws-alice',
      'current-company-state',
      SHA,
      'Sales/Deal.md',
    );
  });

  it('a denied or unresolvable read is 403, and git is never consulted', async () => {
    h = await makeHarness();
    expect((await get(7, 'Secret/x.md')).status).toBe(403);
    expect((await get(7, 'Unknown/x.md')).status).toBe(403);
    expect(h.workflow.fileAtForkPoint).not.toHaveBeenCalled();
  });

  it('refuses a workspace-prefixed path and an unknown request', async () => {
    h = await makeHarness();
    expect((await get(7, 'knowledge-base/Secret/x.md')).status).toBe(400);
    expect((await get(8, 'Sales/Deal.md')).status).toBe(404);
    expect(h.workflow.fileAtForkPoint).not.toHaveBeenCalled();
  });

  it("without a sha, resolves the request's current fork point (the file page's boxes)", async () => {
    h = await makeHarness();
    const res = await get(7, 'Sales/Deal.md', '');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ content: 'price: 100\n', forkSha: SHA });
    expect(h.workflow.changeRequestForkPoint).toHaveBeenCalledWith(
      'ws-alice',
      'current-company-state',
      'alice/deal',
    );
    expect(h.workflow.fileAtForkPoint).toHaveBeenCalledWith('ws-alice', 'current-company-state', SHA, 'Sales/Deal.md');
  });

  it('branches with no shared history answer forkSha: null, and read nothing', async () => {
    h = await makeHarness();
    h.workflow.changeRequestForkPoint.mockResolvedValueOnce(null);
    const res = await get(7, 'Sales/Deal.md', '');
    expect(await res.json()).toEqual({ content: null, forkSha: null });
    expect(h.workflow.fileAtForkPoint).not.toHaveBeenCalled();
  });

  it('a denied read never resolves the fork point either', async () => {
    h = await makeHarness();
    expect((await get(7, 'Secret/x.md', '')).status).toBe(403);
    expect(h.workflow.changeRequestForkPoint).not.toHaveBeenCalled();
  });

  it('refuses a missing path and a non-numeric request before authorizing anything', async () => {
    h = await makeHarness();
    expect((await fetch(`${h.baseUrl}/api/workflow/change-requests/7/fork-point-file?sha=${SHA}`)).status).toBe(400);
    expect((await fetch(`${h.baseUrl}/api/workflow/change-requests/abc/fork-point-file?path=Sales%2FDeal.md`)).status).toBe(400);
    expect(h.canReadAtRef).not.toHaveBeenCalled();
    expect(h.workflow.fileAtForkPoint).not.toHaveBeenCalled();
  });

  it('an access-model error fails closed, not open', async () => {
    h = await makeHarness();
    h.canReadAtRef.mockRejectedValueOnce(new Error('access tree unreadable'));
    const res = await get(7, 'Sales/Deal.md');
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.workflow.fileAtForkPoint).not.toHaveBeenCalled();
  });

  it('a failing git read surfaces as an error, never as an empty file', async () => {
    h = await makeHarness();
    h.workflow.fileAtForkPoint.mockRejectedValueOnce(new Error('git exploded'));
    const res = await get(7, 'Sales/Deal.md');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
