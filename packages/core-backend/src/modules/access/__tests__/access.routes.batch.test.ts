import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { createAccessRoutes } from '../access.routes.js';
import { usersDbDouble } from './users-db-double.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * HTTP contract for `POST /access/batch` — the verb dispatch. Existing callers
 * send no verb and must keep getting the WRITE verdict; the Library's Owner
 * pill sends `verb: owner` and must get the owner-lists-only verdict, which a
 * writer does not hold.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';

interface Harness {
  server: Server;
  baseUrl: string;
  canWriteBatch: ReturnType<typeof vi.fn>;
  canOwnerBatch: ReturnType<typeof vi.fn>;
  canReadBatch: ReturnType<typeof vi.fn>;
}

// Alice WRITES both skills but is named in the `owner:` grant of one, and
// READS a folder she may not write.
const WRITABLE = new Set(['Skills/a/SKILL.md', 'Skills/b/SKILL.md']);
const OWNED = new Set(['Skills/a/SKILL.md']);
const READABLE = new Set(['Skills/a/SKILL.md', 'Skills/b/SKILL.md', 'KnowledgeBase/Sales']);

const verdicts = (set: Set<string>) =>
  vi.fn(async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, set.has(p)])));

async function makeHarness(): Promise<Harness> {
  const canWriteBatch = verdicts(WRITABLE);
  const canOwnerBatch = verdicts(OWNED);
  const canReadBatch = verdicts(READABLE);
  const accessControl = { canWriteBatch, canOwnerBatch, canReadBatch } as unknown as IAccessControl;

  const workspaceService = {} as unknown as WorkspaceService;
  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createAccessRoutes(
      accessControl,
      workspaceService,
      authService,
      {} as unknown as WorkflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      usersDbDouble(),
      testKbContext({ kbDirName: KB }),
    ),
  );

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, canWriteBatch, canOwnerBatch, canReadBatch };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const PATHS = ['Skills/a/SKILL.md', 'Skills/b/SKILL.md'];

describe('POST /access/batch', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const post = (body: unknown) =>
    fetch(`${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('answers WRITE when no verb is sent — the existing callers keep their verdict', async () => {
    h = await makeHarness();

    const res = await post({ paths: PATHS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { 'Skills/a/SKILL.md': true, 'Skills/b/SKILL.md': true } });
    expect(h.canWriteBatch).toHaveBeenCalledWith(WS, USER.email, PATHS);
    expect(h.canOwnerBatch).not.toHaveBeenCalled();
  });

  it('answers WRITE for an explicit `verb: write`', async () => {
    h = await makeHarness();

    const res = await post({ paths: PATHS, verb: 'write' });
    expect(await res.json()).toEqual({ results: { 'Skills/a/SKILL.md': true, 'Skills/b/SKILL.md': true } });
    expect(h.canOwnerBatch).not.toHaveBeenCalled();
  });

  it('answers OWNER for `verb: owner` — a writer who is not owner-listed gets false', async () => {
    h = await makeHarness();

    const res = await post({ paths: PATHS, verb: 'owner' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: { 'Skills/a/SKILL.md': true, 'Skills/b/SKILL.md': false } });
    expect(h.canOwnerBatch).toHaveBeenCalledWith(WS, USER.email, PATHS);
    expect(h.canWriteBatch).not.toHaveBeenCalled();
  });

  it('answers READ for `verb: read` — a folder the caller may read but not write gets true', async () => {
    h = await makeHarness();

    const paths = [...PATHS, 'KnowledgeBase/Sales'];
    const res = await post({ paths, verb: 'read' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: { 'Skills/a/SKILL.md': true, 'Skills/b/SKILL.md': true, 'KnowledgeBase/Sales': true },
    });
    expect(h.canReadBatch).toHaveBeenCalledWith(WS, USER.email, paths);
    expect(h.canWriteBatch).not.toHaveBeenCalled();
    expect(h.canOwnerBatch).not.toHaveBeenCalled();
  });

  it('400s a verb it does not dispatch, resolving nothing', async () => {
    h = await makeHarness();

    for (const verb of ['download', 'admin', 42, null]) {
      const res = await post({ paths: PATHS, verb });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'verb must be "write", "owner" or "read"' });
    }
    expect(h.canWriteBatch).not.toHaveBeenCalled();
    expect(h.canOwnerBatch).not.toHaveBeenCalled();
    expect(h.canReadBatch).not.toHaveBeenCalled();
  });

  it('keeps the paths validation ahead of the verb', async () => {
    h = await makeHarness();

    expect((await post({ paths: 'Skills/a/SKILL.md', verb: 'owner' })).status).toBe(400);
    expect((await post({ paths: Array.from({ length: 501 }, (_, i) => `f${i}.md`) })).status).toBe(400);
  });
});
