import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { InternalTokenService } from '../internal-token.service.js';
import { createManualAuthMiddleware } from '../tool-auth.middleware.js';
import type { IExternalApiKeyService } from '../external-api-key.interface.js';
import type { AuthService } from '../../auth/auth.service.js';

/**
 * The manual endpoints (`/agent/utcp`, `/agent/internal/utcp`) accept a browser
 * JWT in ADDITION to a connection key / internal token, so a logged-in user can
 * browse the catalog with their session — but the internal catalog stays
 * `requireInternalSource`-gated, and a JWT never reaches an execution route.
 */
const KEY = 'bevel_validkey';
const JWT = 'browser-jwt';

const fakeExternalApiKeys = {
  looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
  verifyAndLoadToken: async (t: string) =>
    t === KEY ? { user: { id: 'u-key' }, tokenId: 'tok-1' } : null,
} as unknown as IExternalApiKeyService;

const fakeAuth = {
  verifyToken: (t: string) => {
    if (t === JWT) return { userId: 'u-jwt', email: 'jwt@x' };
    throw new Error('bad jwt');
  },
} as unknown as AuthService;

let server: HttpServer | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function start() {
  const internalTokens = new InternalTokenService({ secret: 'test-secret' });
  const registry = new ToolRegistry();
  registry.registerExternalTool(toolDef({ name: 'pub', description: 'd', path: '/api/agent/tools/pub', inputs: { type: 'object', properties: {} } }));
  registry.registerInternalTool(toolDef({ name: 'sec', description: 'd', path: '/api/agent/tools/sec', inputs: { type: 'object', properties: {} } }));
  const manualAuth = createManualAuthMiddleware(fakeExternalApiKeys, internalTokens, fakeAuth);
  const app = express();
  app.use('/api', createManualRoutes(registry, manualAuth));
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, intToken: internalTokens.mint({ userId: 'u-int' }) };
}

const get = (base: string, path: string, bearer?: string) =>
  fetch(`${base}${path}`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined);

describe('createManualAuthMiddleware (read-only manual endpoints)', () => {
  it('serves the external manual to a browser JWT', async () => {
    const { base } = await start();
    const r = await get(base, '/api/agent/utcp', JWT);
    expect(r.status).toBe(200);
    const m = (await r.json()) as { tools: { name: string }[] };
    expect(m.tools.map((t) => t.name)).toContain('pub');
  });

  it('serves the external manual to a connection key', async () => {
    const { base } = await start();
    expect((await get(base, '/api/agent/utcp', KEY)).status).toBe(200);
  });

  it('401s a missing or unrecognised bearer', async () => {
    const { base } = await start();
    expect((await get(base, '/api/agent/utcp')).status).toBe(401);
    expect((await get(base, '/api/agent/utcp', 'garbage')).status).toBe(401);
  });

  it('refuses the INTERNAL manual to a browser JWT (403) but allows an internal token', async () => {
    const { base, intToken } = await start();
    expect((await get(base, '/api/agent/internal/utcp', JWT)).status).toBe(403);
    expect((await get(base, '/api/agent/internal/utcp', intToken)).status).toBe(200);
  });

  it('refuses the INTERNAL manual to a connection key (403)', async () => {
    const { base } = await start();
    expect((await get(base, '/api/agent/internal/utcp', KEY)).status).toBe(403);
  });
});
