import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { WorkspaceService } from '../workspace.service.js';

/**
 * Contract test for the two file routes an editor that composes a save from a
 * snapshot depends on:
 *
 *   - `PUT /file` carries `ifMatch` through as the service's conditional
 *     write, inside the per-path lock, so a stale save is refused rather than
 *     landing on top of someone else's.
 *   - `GET /file` answers 404 for a MISSING file only. Every other read
 *     failure keeps its own status, because a caller that opens an empty
 *     editor on 404 would otherwise do so over content it could not read.
 */

const USER_ID = 'user-1';
const USER = { id: USER_ID, email: 'alice@example.com', name: 'Alice' };
const WS = 'target-company-state';
const KB = 'knowledge-base';
const FILE = `${KB}/mcp-description.md`;

interface Harness {
  server: Server;
  baseUrl: string;
  writeFileMock: ReturnType<typeof vi.fn>;
  readFileMock: ReturnType<typeof vi.fn>;
  assertContentMatchesMock: ReturnType<typeof vi.fn>;
  planForCreate: ReturnType<typeof vi.fn>;
  seedWrites: string[];
  lockedPaths: string[];
  /** What happened, in order, so the critical section can be asserted. */
  order: string[];
}

async function makeHarness(): Promise<Harness> {
  const lockedPaths: string[] = [];
  const seedWrites: string[] = [];
  const order: string[] = [];
  const readFileMock = vi.fn(async () => 'CONTENT');
  const writeFileMock = vi.fn(async (_id: string, p: string) => {
    if (p.endsWith('/access.md')) {
      seedWrites.push(p);
      order.push('seed');
      return;
    }
    order.push('write');
  });
  // Stands in for the real precondition check: same 409, same "an absent file
  // reads as empty" rule, so the route's ordering is what this exercises.
  const assertContentMatchesMock = vi.fn(async (_id: string, p: string, expected: string) => {
    order.push('precondition');
    let current = '';
    try {
      current = (await readFileMock()) as unknown as string;
    } catch {
      current = '';
    }
    if (current === expected) return;
    const stale: Error & { status?: number } = new Error(`"${p}" changed since you opened it.`);
    stale.status = 409;
    throw stale;
  });
  const withPathTurnMock = vi.fn(async (_id: string, _p: string, op: () => Promise<unknown>) => {
    order.push('turn:enter');
    try {
      return await op();
    } finally {
      order.push('turn:exit');
    }
  });
  const workspaceService = {
    readFile: readFileMock,
    writeFile: writeFileMock,
    assertContentMatches: assertContentMatchesMock,
    withPathTurn: withPathTurnMock,
  } as unknown as WorkspaceService;

  const planForCreate = vi.fn(async () => {
    order.push('plan');
    return null;
  });
  const stubCreatorAccess = {
    planForCreate,
    grantInExtractedFile: async () => null,
    noteAccessFileWritten: () => {},
  } as unknown as ICreatorAccess;

  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async (_w: string, _b: string, p: string) => {
      lockedPaths.push(p);
      return { acquired: true, lock: { holderUserId: USER_ID, holderName: 'Alice' } };
    }),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
  } as unknown as IWorkflowService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;
  const accessControl = {
    canRead: vi.fn(async () => true),
    canReadBatch: vi.fn(async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true]))),
  } as unknown as IAccessControl;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER_ID;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      authService,
      workflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      accessControl,
      KB,
      stubCreatorAccess,
      { isAdmin: async () => true } as unknown as IAdminAccessService,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    writeFileMock,
    readFileMock,
    assertContentMatchesMock,
    planForCreate,
    seedWrites,
    lockedPaths,
    order,
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

function put(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(FILE)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function get(h: Harness): Promise<Response> {
  return fetch(`${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(FILE)}`);
}

/** An fs error as node throws it: the code is what the route reads. */
function errno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe('PUT /workspace/:id/file — ifMatch', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  it('passes the precondition to the service, under the path lock', async () => {
    h = await makeHarness();

    // `CONTENT` is what the harness's file holds, so the precondition holds.
    const res = await put(h, { content: 'After.', ifMatch: 'CONTENT' });

    expect(res.status).toBe(200);
    expect(h.writeFileMock).toHaveBeenCalledWith(WS, FILE, 'After.', {
      failIfExists: false,
      expectedContent: 'CONTENT',
    });
    expect(h.lockedPaths).toEqual([FILE]);
    // The plan still runs on a save that is going ahead.
    expect(h.planForCreate).toHaveBeenCalledTimes(1);
  });

  it('leaves the precondition unset when the caller sends none', async () => {
    h = await makeHarness();

    const res = await put(h, { content: 'After.' });

    expect(res.status).toBe(200);
    expect(h.writeFileMock).toHaveBeenCalledWith(WS, FILE, 'After.', {
      failIfExists: false,
      expectedContent: undefined,
    });
  });

  it("sends the WRITE's own 409 and its reason back to the caller", async () => {
    // `CONTENT` passes the precondition, so the rejection under test is the
    // write's — the compare that happens at the bytes, after the precheck.
    h = await makeHarness();
    const stale: Error & { status?: number } = new Error(`"${FILE}" changed since you opened it.`);
    stale.status = 409;
    h.writeFileMock.mockRejectedValue(stale);

    const res = await put(h, { content: 'After.', ifMatch: 'CONTENT' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('changed since you opened it');
    expect(h.writeFileMock).toHaveBeenCalled();
  });

  it('coordinates on one identity: an odd spelling locks and writes the canonical path', async () => {
    // The turn, the lock row and the bytes must be the same file, whichever
    // accepted spelling the caller sent.
    h = await makeHarness();

    const res = await fetch(
      `${h.baseUrl}/api/workspace/${WS}/file?path=${encodeURIComponent(`./${KB}//mcp-description.md`)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'After.', ifMatch: 'CONTENT' }),
      },
    );

    expect(res.status).toBe(200);
    expect(h.assertContentMatchesMock).toHaveBeenCalledWith(WS, FILE, 'CONTENT');
    expect(h.writeFileMock).toHaveBeenCalledWith(WS, FILE, 'After.', {
      failIfExists: false,
      expectedContent: 'CONTENT',
    });
    expect(h.lockedPaths).toEqual([FILE]);
  });

  it('refuses a non-string precondition instead of dropping it', async () => {
    h = await makeHarness();

    const res = await put(h, { content: 'After.', ifMatch: 42 });

    expect(res.status).toBe(400);
    expect(h.writeFileMock).not.toHaveBeenCalled();
  });

  it('runs the precondition, the plan and the write inside ONE turn for the path', async () => {
    // The decision spans three steps, so nothing may touch the file between
    // the check and the write: a save landing in the middle would leave a
    // committed access grant behind for a write about to be refused.
    h = await makeHarness();
    h.planForCreate.mockImplementation(async () => {
      h!.order.push('plan');
      return { kind: 'seed-access-md', wsRelPath: `${KB}/access.md`, apply: () => 'seed' } as never;
    });

    const res = await put(h, { content: 'After.', ifMatch: 'CONTENT' });

    expect(res.status).toBe(200);
    expect(h.order).toEqual(['turn:enter', 'precondition', 'plan', 'seed', 'write', 'turn:exit']);
  });

  it('checks the precondition BEFORE the creator-access plan, so a refusal seeds no access grant', async () => {
    // The seed commits under its own lock. A precondition that failed after it
    // would leave an authorization grant behind for a save that never landed.
    h = await makeHarness();
    h.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: `${KB}/access.md`,
      apply: () => 'seed',
    } as never);

    const res = await put(h, { content: 'After.', ifMatch: 'Stale.' });

    expect(res.status).toBe(409);
    expect(h.assertContentMatchesMock).toHaveBeenCalledWith(WS, FILE, 'Stale.');
    expect(h.planForCreate).not.toHaveBeenCalled();
    expect(h.seedWrites).toEqual([]);
    expect(h.writeFileMock).not.toHaveBeenCalled();
    expect(h.lockedPaths).toEqual([]);
    expect(h.order).toEqual(['turn:enter', 'precondition', 'turn:exit']);
  });
});

describe('GET /workspace/:id/file — read failures', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  it.each(['ENOENT', 'ENOTDIR', 'EISDIR'])('answers 404 when there is no file to read (%s)', async (code) => {
    h = await makeHarness();
    h.readFileMock.mockRejectedValue(errno(code, 'no such file'));

    const res = await get(h);

    expect(res.status).toBe(404);
  });

  it('answers 500 for a file that exists but cannot be read', async () => {
    h = await makeHarness();
    h.readFileMock.mockRejectedValue(errno('EACCES', 'permission denied'));

    const res = await get(h);

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('permission denied');
  });

  it('keeps a traversal refusal a 403', async () => {
    h = await makeHarness();
    h.readFileMock.mockRejectedValue(new Error('Path traversal detected'));

    const res = await get(h);

    expect(res.status).toBe(403);
  });
});
