import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../tool-def.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware, requireInternalSource } from '../../tool-auth/tool-auth.middleware.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import type { ToolContext } from '../tool.contract.js';

/**
 * Integration test for the Phase 1 machinery: the ONE mechanism (host endpoint +
 * register def), the dual `toolAuth` (connection key OR internal token resolving
 * to a normalized context), write-scope enforcement, and the two manual
 * endpoints — over a real express app.
 */

const WS = 'target-company-state';

// Minimal service stubs (list_branches/touch don't touch the filesystem, so the
// lazy LockingFilesystem is never built).
const externalApiKeyService = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === 'bevel_good' ? { user: { id: 'user-A', email: 'e@x', name: 'N' }, tokenId: 'tok-1' } : null,
} as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: WS }),
  getWorkspacePath: async () => '/tmp/ws',
} as never;
const workflowService = { listBranches: async () => [{ name: 'main', isProtected: true }] } as never;
const events = {} as never;

let httpServer: HttpServer | undefined;
const internalToken = new InternalTokenService({ secret: 'test-secret' });

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({ authService, workspaceService, workflowService, events, kbDirName: 'knowledge-base', creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} } });
  const toolHandler = createToolHandlerFactory(resolve);

  registry.registerExternalTool(
    toolDef({ name: 'list_branches', description: 'list', path: '/api/agent/tools/list_branches', inputs: { type: 'object', properties: {} } }),
  );
  registry.registerInternalTool(
    toolDef({ name: 'list_branches', description: 'list', path: '/api/agent/tools/list_branches', inputs: { type: 'object', properties: {} } }),
  );
  registry.registerInternalTool(
    toolDef({ name: 'touch', description: 'write', path: '/api/agent/tools/touch', inputs: { type: 'object', properties: {} }, tags: ['write'] }),
  );

  const app = express();
  app.use(express.json());
  app.post(
    '/api/agent/tools/list_branches',
    toolAuth,
    toolHandler(async (_a: Record<string, unknown>, ctx: ToolContext) => ({
      branches: await ctx.workflowService.listBranches('ws'),
      ranAs: ctx.user.id,
      source: ctx.source,
    })),
  );
  // `touch` is internal-only (registered only via registerInternalTool) AND
  // write-tagged — so its route carries the internal-source gate, mirroring the
  // production mount helpers.
  app.post(
    '/api/agent/tools/touch',
    toolAuth,
    requireInternalSource,
    toolHandler(async () => ({ ok: true }), { write: true }),
  );
  // Internal-only route: mounted (our agent reaches it over loopback) but gated.
  app.post(
    '/api/agent/tools/secret_internal',
    toolAuth,
    requireInternalSource,
    toolHandler(async () => ({ ok: true })),
  );
  app.use('/api', createManualRoutes(registry, toolAuth));

  httpServer = await new Promise<HttpServer>((resolve2) => {
    const s = app.listen(0, () => resolve2(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

const post = (url: string, bearer: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });

const get = (url: string, bearer: string) => fetch(url, { headers: { authorization: `Bearer ${bearer}` } });

describe('tools surface — dual auth + scope + manuals', () => {
  it('dispatches the same tool under BOTH a connection key and an internal token', async () => {
    const base = await start();
    const keyRes = await post(`${base}/api/agent/tools/list_branches`, 'bevel_good');
    expect(keyRes.status).toBe(200);
    expect(await keyRes.json()).toMatchObject({ branches: [{ name: 'main' }], ranAs: 'user-A', source: 'external' });

    const intTok = internalToken.mint({ userId: 'user-A' });
    const intRes = await post(`${base}/api/agent/tools/list_branches`, intTok);
    expect(intRes.status).toBe(200);
    expect(await intRes.json()).toMatchObject({ source: 'internal', ranAs: 'user-A' });
  });

  it('rejects a bad/absent bearer (401)', async () => {
    const base = await start();
    expect((await post(`${base}/api/agent/tools/list_branches`, 'nonsense')).status).toBe(401);
    expect((await fetch(`${base}/api/agent/tools/list_branches`, { method: 'POST' })).status).toBe(401);
  });

  it('serves filtered manuals: internal has list_branches+touch, external only list_branches', async () => {
    const base = await start();
    const intTok = internalToken.mint({ userId: 'user-A' });
    const internal = (await (await get(`${base}/api/agent/internal/utcp`, intTok)).json()) as { tools: { name: string }[] };
    const external = (await (await get(`${base}/api/agent/utcp`, 'bevel_good')).json()) as { tools: { name: string }[] };
    expect(internal.tools.map((t) => t.name).sort()).toEqual(['list_branches', 'touch']);
    expect(external.tools.map((t) => t.name)).toEqual(['list_branches']);
  });

  it('refuses internal-only surfaces to an external connection key (403), but admits an internal token', async () => {
    const base = await start();
    const intTok = internalToken.mint({ userId: 'user-A' });

    // The internal tool catalog: external key authenticates but is not internal.
    expect((await get(`${base}/api/agent/internal/utcp`, 'bevel_good')).status).toBe(403);
    expect((await get(`${base}/api/agent/internal/utcp`, intTok)).status).toBe(200);

    // Internal-only tool routes, reached directly by name, are gated the same
    // way — an external write-scope key can't bypass the catalog filtering by
    // POSTing the route directly. (`touch` is also write-tagged.)
    expect((await post(`${base}/api/agent/tools/secret_internal`, 'bevel_good')).status).toBe(403);
    expect((await post(`${base}/api/agent/tools/secret_internal`, intTok)).status).toBe(200);
    expect((await post(`${base}/api/agent/tools/touch`, 'bevel_good')).status).toBe(403);
    expect((await post(`${base}/api/agent/tools/touch`, intTok)).status).toBe(200);
  });
});
