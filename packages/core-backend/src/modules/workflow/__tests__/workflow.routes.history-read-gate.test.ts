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

// A file's history is its content with a time axis: the same default-deny
// read model that hides a file must hide its commit list, its diffs, and its
// content at any commit. These routes used to require only "is authenticated".

const USER = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';
const allow = (p: string) => !p.includes('Secret');

interface Harness {
  server: Server;
  canRead: ReturnType<typeof vi.fn>;
  workflow: {
    listChangesForFile: ReturnType<typeof vi.fn>;
    compareFile: ReturnType<typeof vi.fn>;
    showFileAtChange: ReturnType<typeof vi.fn>;
    fileAtChange: ReturnType<typeof vi.fn>;
  };
  baseUrl: string;
}

async function makeHarness(): Promise<Harness> {
  const canRead = vi.fn(async (_w: string, _e: string, p: string) => allow(p));
  const accessControl = { canRead } as unknown as IAccessControl;
  const workflow = {
    listChangesForFile: vi.fn(async () => []),
    compareFile: vi.fn(async () => ''),
    showFileAtChange: vi.fn(async () => ''),
    fileAtChange: vi.fn(async () => ({ baseline: null, current: 'x' })),
  };
  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

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
      {} as unknown as WorkspaceService,
      authService,
      { subscribe: vi.fn(), publish: vi.fn() } as unknown as WorkflowEventBus,
      accessControl,
      KB,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, canRead, workflow, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const OPEN = encodeURIComponent(`${KB}/Open/a.md`);
const SECRET = encodeURIComponent(`${KB}/Secret/x.md`);

describe('history routes enforce the read model', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });
  const get = (p: string) => fetch(`${h!.baseUrl}/api/workspace/${WS}/workflow${p}`);

  it.each([
    ['/changes?path=%s', 'listChangesForFile'],
    ['/show-file?sha=abc&path=%s', 'showFileAtChange'],
    ['/file-at-change?sha=abc&path=%s', 'fileAtChange'],
    ['/compare-file?from=a&to=b&path=%s', 'compareFile'],
  ] as const)('%s: readable → 200, denied → 403 and git is never consulted', async (route, method) => {
    h = await makeHarness();
    expect((await get(route.replace('%s', OPEN))).status).toBe(200);
    expect((await get(route.replace('%s', SECRET))).status).toBe(403);
    // The denial happened BEFORE the service — nothing read the repository.
    const calls = h.workflow[method].mock.calls as unknown[][];
    expect(calls.length).toBe(1);
    expect(String(calls[0][1])).toContain('Open');
  });

  it('a non-KB path carries no read rules and passes without consulting canRead', async () => {
    h = await makeHarness();
    const res = await get(`/changes?path=${encodeURIComponent('scratch/notes.txt')}`);
    expect(res.status).toBe(200);
    expect(h.canRead).not.toHaveBeenCalled();
  });

  it('an access-model error fails closed, not open', async () => {
    h = await makeHarness();
    h.canRead.mockRejectedValueOnce(new Error('access tree unreadable'));
    const res = await get(`/changes?path=${OPEN}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.workflow.listChangesForFile).not.toHaveBeenCalled();
  });
});
