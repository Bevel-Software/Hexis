import type { Server as HttpServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { createToolManualsAgentRoutes } from '../tool-manuals.routes.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IToolManualService } from '../tool-manuals.contract.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../agent-scope/index.js';

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

async function baseUrl(
  pluginIndex?: { catalog(): Promise<{ name: string; folders: string[] }[]> },
  /** The connection's `.agent` choice; absent is Everything. */
  connection?: { agentPath: string; agentScope?: Pick<IAgentScopeResolver, 'resolve'> },
  toolManualService: IToolManualService = {} as unknown as IToolManualService,
): Promise<string> {
  const app = express();
  const manualAuth: express.RequestHandler = (req, _res, next) => {
    req.toolAuth = { userId: 'u-1', ...(connection ? { agentPath: connection.agentPath } : {}) } as never;
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
      toolManualService,
      manualAuth,
      async () => 'ali@example.com',
      { workspaceService, accessControl, kb: testKbContext({ kbDirName: KB }), disk: new NodeFs(), pluginIndex: pluginIndex as never },
      connection?.agentScope,
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

const OPS = { path: 'Agents/ops.agent', name: 'Ops' };
/** A resolver that narrows every connection to `connectors`. */
function loading(connectors: string[]): Pick<IAgentScopeResolver, 'resolve'> {
  return { resolve: async () => ConnectionScope.narrowed(OPS, { skills: [], connectors, platformTools: null }, 'fp') };
}

describe('GET /agent/plugins/:folder/archive', () => {
  it("a connection made as an .agent file archives only a plugin defining a connector the file loads", async () => {
    const pluginDir = path.join(wsDir, KB, 'Plugins', 'GTM');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'mcp.json'), '{"mcpServers":{}}', 'utf-8');
    const archive = async (connectors: string[] | null) => {
      const base = await baseUrl(undefined, {
        agentPath: OPS.path,
        ...(connectors ? { agentScope: loading(connectors) } : {}),
      });
      const res = await fetch(`${base}/api/agent/plugins/GTM/archive`);
      await new Promise<void>((r) => httpServer!.close(() => r()));
      httpServer = undefined;
      return res;
    };
    // The plugin's own definition file, the plugin folder, a folder above it.
    expect((await archive(['Plugins/GTM/mcp.json'])).status).toBe(200);
    expect((await archive(['Plugins/GTM'])).status).toBe(200);
    expect((await archive(['Plugins'])).status).toBe(200);
    // A connector elsewhere: refused by name, before anything is read.
    const refused = await archive(['Plugins/Other']);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error: string; code: string };
    expect(body.code).toBe('not_available_to_connection');
    expect(body.error).toContain('The plugin "GTM" is not available to this connection.');
    // A narrowed connection with no resolver wired loads nothing.
    expect((await archive(null)).status).toBe(403);
  });

  it('zips a readable plugin folder', async () => {
    const pluginDir = path.join(wsDir, KB, 'Plugins', 'GTM');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'web-search.tool'), '{"name":"web_search"}', 'utf-8');
    const base = await baseUrl();
    const res = await fetch(`${base}/api/agent/plugins/GTM/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
  });

  it('zips a plugin nested below the root by its IDENTITY, which the index maps to its folder', async () => {
    const pluginDir = path.join(wsDir, KB, 'Plugins', 'departments', 'engineering', 'ado');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'plugin.bundle.json'), '{"name":"ado"}', 'utf-8');
    await fs.writeFile(path.join(pluginDir, 'CONVENTIONS.md'), '# conventions', 'utf-8');
    const base = await baseUrl({
      catalog: async () => [{ name: 'ado', folders: ['Plugins/departments/engineering/ado'] }],
    });
    const res = await fetch(`${base}/api/agent/plugins/ado/archive`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    // A name the index does not know either is still an absence.
    expect((await fetch(`${base}/api/agent/plugins/nope/archive`)).status).toBe(404);
    // A stray FILE at the root name is not a plugin folder: the identity still resolves.
    await fs.writeFile(path.join(wsDir, KB, 'Plugins', 'ado'), 'not a folder', 'utf-8');
    expect((await fetch(`${base}/api/agent/plugins/ado/archive`)).status).toBe(200);
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

describe('GET /tools/:slug/manual', () => {
  it("narrows an inline manual read to the connectors the connection's .agent file loads", async () => {
    const resolveInlineManual = vi.fn(async () => ({ utcp_version: '1.1.0', manual_version: '1.0.0', tools: [] }));
    const service = { resolveInlineManual } as unknown as IToolManualService;
    // Everything asks exactly what it asked before: no narrowing at all.
    let base = await baseUrl(undefined, undefined, service);
    expect((await fetch(`${base}/api/tools/weather/manual`)).status).toBe(200);
    expect(resolveInlineManual).toHaveBeenLastCalledWith('ali@example.com', 'weather', undefined);
    await new Promise<void>((r) => httpServer!.close(() => r()));

    base = await baseUrl(undefined, { agentPath: OPS.path, agentScope: loading(['Plugins/GTM']) }, service);
    expect((await fetch(`${base}/api/tools/weather/manual`)).status).toBe(200);
    const within = (resolveInlineManual.mock.calls.at(-1) as unknown[])[2] as { within: (p: string) => boolean };
    expect(within.within('Plugins/GTM/weather.tool')).toBe(true);
    expect(within.within('Plugins/Other/weather.tool')).toBe(false);
  });
});
