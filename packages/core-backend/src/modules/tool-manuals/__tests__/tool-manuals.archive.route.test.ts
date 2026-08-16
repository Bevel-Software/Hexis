import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { createToolManualsAgentRoutes } from '../tool-manuals.routes.js';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IToolManualService } from '../tool-manuals.contract.js';

/**
 * `GET /agent/plugins/:folder/archive` — error taxonomy of the plugin-folder
 * probe. An ABSENT folder is a 404; a folder the process cannot lstat
 * (EACCES, EIO) is a real failure that must surface as a 500, because a 404
 * would report a permission problem as "this plugin does not exist" and the
 * caller would delete its local copy of a plugin that is still there.
 */

const KB = 'knowledge-base';

let httpServer: HttpServer | undefined;
let root: string;
let wsDir: string;

async function baseUrl(): Promise<string> {
  const app = express();
  const manualAuth: express.RequestHandler = (req, _res, next) => {
    req.toolAuth = { userId: 'u-1' } as never;
    next();
  };
  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: workspaceIdForBranch(DEFAULT_BRANCH) })),
    getWorkspacePath: vi.fn(async () => wsDir),
  } as unknown as WorkspaceService;
  const accessControl = {
    canReadBatch: vi.fn(async (_ws: string, _email: string, rels: string[]) => {
      return new Map(rels.map((r) => [r, true]));
    }),
  } as unknown as IAccessControl;
  app.use(
    '/api',
    createToolManualsAgentRoutes(
      {} as unknown as IToolManualService,
      manualAuth,
      async () => 'ali@example.com',
      { workspaceService, accessControl, kbDirName: KB },
    ),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-archive-'));
  wsDir = path.join(root, workspaceIdForBranch(DEFAULT_BRANCH));
  await fs.mkdir(wsDir, { recursive: true });
});

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('GET /agent/plugins/:folder/archive', () => {
  it('zips a readable plugin folder', async () => {
    const pluginDir = path.join(wsDir, KB, 'Plugins', 'GTM');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'web-search.tool'), '{"name":"web_search"}', 'utf-8');
    const base = await baseUrl();
    const res = await fetch(`${base}/api/agent/plugins/GTM/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
  });

  it('404s an absent plugin folder — ENOENT is an absence', async () => {
    const base = await baseUrl();
    const res = await fetch(`${base}/api/agent/plugins/Nope/archive`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('500s when the folder probe fails for a non-ENOENT reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const denied: NodeJS.ErrnoException = Object.assign(new Error('EACCES: permission denied'), {
      code: 'EACCES',
    });
    vi.spyOn(fs, 'lstat').mockRejectedValueOnce(denied);
    const base = await baseUrl();
    const res = await fetch(`${base}/api/agent/plugins/GTM/archive`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to archive plugin' });
  });
});
