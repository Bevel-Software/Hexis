import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IDiffService } from '../diff.interface.js';
import { createDiffRoutes } from '../diff.routes.js';

const USER = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
const WS = 'target-company-state';
const KB = 'knowledge-base';
const allow = (p: string) => !p.includes('Secret');

interface Harness {
  server: Server;
  baseUrl: string;
}

async function makeHarness(opts: {
  changes?: { path: string }[];
  fileDiff?: () => Promise<unknown>;
}): Promise<Harness> {
  const batch = async (_w: string, _e: string, paths: string[]) =>
    new Map(paths.map((p) => [p, allow(p)]));
  const accessControl = {
    canRead: vi.fn(async (_w: string, _e: string, p: string) => allow(p)),
    canReadBatch: vi.fn(batch),
  } as unknown as IAccessControl;

  const diffService = {
    currentSession: vi.fn(async () =>
      opts.changes
        ? { branchName: 'b', baselineRef: '', createdAt: '0', changes: opts.changes }
        : null,
    ),
    fileDiff: vi.fn(opts.fileDiff ?? (async () => ({ path: 'x', before: '', after: '' }))),
  } as unknown as IDiffService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use('/api', createDiffRoutes(diffService, authService, {} as unknown as IWorkflowService, accessControl, KB));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

describe('diff/review read gates', () => {
  let h: Harness | null = null;
  afterEach(async () => { if (h) await close(h.server); h = null; });
  const get = (p: string) => fetch(`${h!.baseUrl}/api/workspace/${WS}${p}`);

  it('GET /review drops changes to unreadable nodes', async () => {
    h = await makeHarness({
      changes: [{ path: `${KB}/Open/a.md` }, { path: `${KB}/Secret/x.md` }],
    });
    const res = await get('/review');
    expect(res.status).toBe(200);
    const { session } = await res.json();
    expect(session.changes.map((c: { path: string }) => c.path)).toEqual([`${KB}/Open/a.md`]);
  });

  it('GET /review returns null when every change is unreadable', async () => {
    h = await makeHarness({ changes: [{ path: `${KB}/Secret/x.md` }, { path: `${KB}/Secret/y.md` }] });
    const { session } = await (await get('/review')).json();
    expect(session).toBeNull();
  });

  it('GET /review/file: readable → 200, denied → 403', async () => {
    h = await makeHarness({ changes: [] });
    expect((await get(`/review/file?path=${encodeURIComponent(`${KB}/Open/a.md`)}`)).status).toBe(200);
    expect((await get(`/review/file?path=${encodeURIComponent(`${KB}/Secret/x.md`)}`)).status).toBe(403);
  });
});
