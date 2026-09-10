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

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

interface Harness {
  server: Server;
  baseUrl: string;
  writeFileMock: ReturnType<typeof vi.fn>;
  readFileMock: ReturnType<typeof vi.fn>;
  lockedPaths: string[];
}

async function makeHarness(): Promise<Harness> {
  const lockedPaths: string[] = [];
  const writeFileMock = vi.fn(async () => undefined);
  const readFileMock = vi.fn(async () => 'CONTENT');
  const workspaceService = {
    readFile: readFileMock,
    writeFile: writeFileMock,
  } as unknown as WorkspaceService;

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
  return { server, baseUrl: `http://127.0.0.1:${addr.port}`, writeFileMock, readFileMock, lockedPaths };
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

    const res = await put(h, { content: 'After.', ifMatch: 'Before.' });

    expect(res.status).toBe(200);
    expect(h.writeFileMock).toHaveBeenCalledWith(WS, FILE, 'After.', {
      failIfExists: false,
      expectedContent: 'Before.',
    });
    expect(h.lockedPaths).toEqual([FILE]);
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

  it("sends the service's 409 and its reason back to the caller", async () => {
    h = await makeHarness();
    const stale: Error & { status?: number } = new Error(`"${FILE}" changed since you opened it.`);
    stale.status = 409;
    h.writeFileMock.mockRejectedValue(stale);

    const res = await put(h, { content: 'After.', ifMatch: 'Stale.' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('changed since you opened it');
  });

  it('refuses a non-string precondition instead of dropping it', async () => {
    h = await makeHarness();

    const res = await put(h, { content: 'After.', ifMatch: 42 });

    expect(res.status).toBe(400);
    expect(h.writeFileMock).not.toHaveBeenCalled();
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
