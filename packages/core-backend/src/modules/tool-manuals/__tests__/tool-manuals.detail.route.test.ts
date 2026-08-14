import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, test, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { createToolManualsBrowserRoutes } from '../tool-manuals.routes.js';
import { ToolManualService } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { IToolManualService, ToolManualDetail } from '../tool-manuals.contract.js';

/**
 * `GET /api/tools/:slug` — the browser tool page's detail read. Two halves:
 * the ROUTE (auth gating + the fail-closed 404, over a stub service on a real
 * loopback server, the harness style the other route tests use) and the
 * SERVICE's capability derivation (over a real temp KB, because deriving
 * capabilities from author-written `tools` is the only logic here worth
 * testing and a stub would test nothing).
 */

const DETAIL: ToolManualDetail = {
  slug: 'github',
  name: 'github',
  path: 'Plugins/Engineering/github.tool',
  type: 'inline',
  description: 'Read and write GitHub issues and PRs.',
  capabilities: [{ name: 'create_issue', description: 'Open an issue in a repo.' }],
};

let httpServer: HttpServer | undefined;

/** Mount the browser routes behind a fake auth middleware; `email` undefined ⇒ unauthenticated. */
async function baseUrlAs(
  email: string | undefined,
  getDetail: IToolManualService['getDetail'],
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (email) req.userEmail = email;
    next();
  });
  const toolManualService = { getDetail } as unknown as IToolManualService;
  app.use('/api', createToolManualsBrowserRoutes(toolManualService));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

describe('GET /api/tools/:slug — route', () => {
  it('returns 200 { tool } with description and capabilities for a readable tool', async () => {
    const base = await baseUrlAs('reader@x.com', async () => DETAIL);
    const res = await fetch(`${base}/api/tools/github`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tool: DETAIL });
  });

  it('passes the caller email and the slug through to the service', async () => {
    const getDetail = vi.fn(async () => DETAIL);
    const base = await baseUrlAs('reader@x.com', getDetail);
    await fetch(`${base}/api/tools/github`);
    expect(getDetail).toHaveBeenCalledWith('reader@x.com', 'github');
  });

  it('404s an unknown slug', async () => {
    const base = await baseUrlAs('reader@x.com', async () => null);
    const res = await fetch(`${base}/api/tools/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('404s — identically — a tool the caller cannot read', async () => {
    // Fail-closed: a caller without read access gets the SAME response an
    // absent slug produces, so a 404 can never confirm a hidden tool exists.
    const unreadable = await baseUrlAs('outsider@x.com', async () => null);
    const unknownRes = await fetch(`${unreadable}/api/tools/github`);
    expect(unknownRes.status).toBe(404);
    expect(await unknownRes.json()).toEqual({ error: 'Not found' });
  });

  it('401s without an authenticated email', async () => {
    const getDetail = vi.fn(async () => DETAIL);
    const base = await baseUrlAs(undefined, getDetail);
    const res = await fetch(`${base}/api/tools/github`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Not authenticated' });
    expect(getDetail).not.toHaveBeenCalled(); // never even asks the service
  });

  it('500s with a generic message when the service throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = await baseUrlAs('reader@x.com', async () => {
      throw new Error('disk on fire');
    });
    const res = await fetch(`${base}/api/tools/github`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load tool' });
  });

  it('does not shadow the literal POST /tools/preview sibling', async () => {
    // The param route is GET-only, so the draft-validation route still gets its
    // own POSTs — the one registration-order hazard this route introduces.
    const preview = vi.fn(async () => ({ ok: true }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userEmail = 'reader@x.com';
      next();
    });
    app.use(
      '/api',
      createToolManualsBrowserRoutes({
        getDetail: async () => DETAIL,
        preview,
      } as unknown as IToolManualService),
    );
    httpServer = await new Promise<HttpServer>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (httpServer.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/tools/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{}' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(preview).toHaveBeenCalledWith('{}');
  });
});

describe('ToolManualService.getDetail — capabilities + access', () => {
  const KB_DIR = 'knowledge-base';
  const wsId = workspaceIdForBranch(DEFAULT_BRANCH);
  let root: string;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;

  const allowAll: IAccessControl = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const denyAll: IAccessControl = {
    canRead: async () => false,
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, false])),
  } as unknown as IAccessControl;

  const svc = (access: IAccessControl = allowAll) => new ToolManualService(workspaceService, access, KB_DIR);

  /** Write one `.tool` into a fresh temp KB and return the service over it. */
  async function withTool(file: string, content: string): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'tooldetail-'));
    const tools = join(root, wsId, KB_DIR, 'Plugins');
    await mkdir(tools, { recursive: true });
    await writeFile(join(tools, file), content);
  }

  afterEach(() => rm(root, { recursive: true, force: true }));

  test('an inline tool reports its description and its embedded tools as capabilities', async () => {
    await withTool(
      'github.tool',
      JSON.stringify({
        name: 'github',
        type: 'inline',
        description: '  Read and write GitHub issues and PRs.  ',
        tools: [
          { name: 'create_issue', description: 'Open an issue in a repo.' },
          { name: 'list_prs' }, // no description → null, still a capability
        ],
      }),
    );
    const detail = await svc().getDetail('user@x.eu', 'github');
    expect(detail).toMatchObject({
      slug: 'github',
      name: 'github',
      path: 'Plugins/github.tool',
      type: 'inline',
      description: 'Read and write GitHub issues and PRs.',
      capabilities: [
        { name: 'create_issue', description: 'Open an issue in a repo.' },
        { name: 'list_prs', description: null },
      ],
    });
  });

  test('description is null (not undefined) when the file declares none', async () => {
    await withTool('bare.tool', JSON.stringify({ name: 'bare', type: 'inline', tools: [] }));
    const detail = await svc().getDetail('user@x.eu', 'bare');
    expect(detail?.description).toBeNull();
    expect(detail?.capabilities).toEqual([]);
  });

  test('http and mcp manuals report no capabilities (their tools resolve at call time)', async () => {
    await withTool('billing.tool', JSON.stringify({ name: 'billing', type: 'http', url: 'https://api.example.com/utcp' }));
    expect((await svc().getDetail('user@x.eu', 'billing'))?.capabilities).toEqual([]);
    await withTool('remote.tool', JSON.stringify({ name: 'remote', type: 'mcp', url: 'https://mcp.example.com/mcp' }));
    expect((await svc().getDetail('user@x.eu', 'remote'))?.capabilities).toEqual([]);
  });

  test('malformed `tools` entries are skipped, not rendered as blank bullets', async () => {
    // `tools` is `unknown[]` — only validated when actually served as a UTCP
    // manual — so the page's derivation has to re-check every entry itself.
    await withTool(
      'messy.tool',
      JSON.stringify({
        name: 'messy',
        type: 'inline',
        tools: [
          null,
          'just a string',
          ['an', 'array'],
          { description: 'nameless' },
          { name: 42 },
          { name: '   ' },
          { name: 'ok', description: 7 }, // non-string description → null
          { name: 'fine', description: 'Works.' },
        ],
      }),
    );
    expect((await svc().getDetail('user@x.eu', 'messy'))?.capabilities).toEqual([
      { name: 'ok', description: null },
      { name: 'fine', description: 'Works.' },
    ]);
  });

  test('caps capabilities at 100 so one `.tool` cannot produce an unbounded page', async () => {
    await withTool(
      'many.tool',
      JSON.stringify({
        name: 'many',
        type: 'inline',
        tools: Array.from({ length: 150 }, (_, i) => ({ name: `t${i}` })),
      }),
    );
    const caps = (await svc().getDetail('user@x.eu', 'many'))!.capabilities;
    expect(caps).toHaveLength(100);
    expect(caps[0].name).toBe('t0');
    expect(caps[99].name).toBe('t99');
  });

  test('returns null for an unknown slug and for a tool the caller cannot read', async () => {
    await withTool('github.tool', JSON.stringify({ name: 'github', type: 'inline', tools: [] }));
    expect(await svc().getDetail('user@x.eu', 'nosuchtool')).toBeNull();
    expect(await svc(denyAll).getDetail('user@x.eu', 'github')).toBeNull();
  });
});
