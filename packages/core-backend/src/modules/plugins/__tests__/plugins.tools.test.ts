import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { keyOrSessionAuth } from '../../tool-auth/key-or-session.middleware.js';
import { createAuthMiddleware } from '../../auth/auth.middleware.js';
import { registerPluginsTools, CREATE_PLUGIN, MY_PLUGIN } from '../plugins.tools.js';
import { createPluginCreationRoutes } from '../plugins.routes.js';
import { PluginProvisionError } from '../plugin-provision.service.js';

/**
 * The plugin tools are DESCRIPTIONS of the app's own creation endpoints.
 * Two things to hold: the definitions point at those endpoints and are in
 * every surface's catalog; and the endpoints admit an agent's connection
 * key through the key-or-session gate exactly as they admit a session —
 * one implementation, whoever knocks.
 */

const ALICE = { id: 'user-alice', email: 'alice@x.com', name: 'Alice' };

describe('the tool definitions', () => {
  it('describe the creation endpoints, and reach every surface', async () => {
    expect((CREATE_PLUGIN.tool_call_template as { url: string }).url).toBe('${API_URL}/api/plugins');
    expect((MY_PLUGIN.tool_call_template as { url: string }).url).toBe('${API_URL}/api/plugins/personal');
    const registry = new ToolRegistry();
    registerPluginsTools(registry);
    for (const tools of [await registry.listExternal({ userEmail: ALICE.email }), await registry.listInternal({ userEmail: ALICE.email })]) {
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['my_plugin', 'create_plugin']));
    }
  });
});

describe('the creation endpoints behind the key-or-session gate', () => {
  const ensurePersonalPlugin = vi.fn(async (user: { id: string }) => ({
    folder: `personal-${user.id}`,
    path: `Plugins/personal-${user.id}`,
    skillsDir: `Plugins/personal-${user.id}/skills`,
    name: `personal-${user.id}`,
    created: true,
  }));
  const createPlugin = vi.fn(async (_user: unknown, name: string, parent?: string) => {
    const folder = parent ? `${parent}/${name}` : name;
    return { folder, path: `Plugins/${folder}`, skillsDir: `Plugins/${folder}/skills`, name: name.toLowerCase(), created: true };
  });

  let httpServer: HttpServer | undefined;

  const externalApiKeyService = {
    looksLikeExternalApiKey: (t: string) => typeof t === 'string' && t.startsWith('bevel_'),
    verifyAndLoadToken: async (t: string) => (t === 'bevel_alice' ? { user: ALICE, tokenId: 'tok-a' } : null),
  } as never;
  const authService = {
    getUserById: async (id: string) => (id === ALICE.id ? ALICE : null),
    verifyToken: (t: string) => {
      if (t !== 'session-alice') throw new Error('bad token');
      return { userId: ALICE.id, email: ALICE.email };
    },
  } as never;

  async function start(): Promise<string> {
    const internalToken = new InternalTokenService({ secret: 'test-secret' });
    const app = express();
    app.use(express.json());
    app.use(
      '/api',
      keyOrSessionAuth({
        sessionAuth: createAuthMiddleware(authService),
        toolAuth: createToolAuthMiddleware(externalApiKeyService, internalToken),
        isToolCredential: (t) => internalToken.looksLikeInternalToken(t) || externalApiKeyService.looksLikeExternalApiKey(t),
      }),
      createPluginCreationRoutes({ ensurePersonalPlugin, createPlugin } as never, async (req) =>
        req.userId ? ((await (authService as { getUserById(id: string): Promise<unknown> }).getUserById(req.userId)) as never) : null,
      ),
    );
    httpServer = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  }

  afterEach(async () => {
    if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
    httpServer = undefined;
    vi.clearAllMocks();
  });

  const post = (base: string, path: string, body: unknown, bearer: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });

  it("a connection key reaches the same endpoint a session does, as the same person", async () => {
    const base = await start();
    const byKey = await post(base, '/api/plugins', { name: 'GTM', parent: 'Teams' }, 'bevel_alice');
    expect(byKey.status).toBe(201);
    expect(await byKey.json()).toEqual({
      folder: 'Teams/GTM',
      path: 'Plugins/Teams/GTM',
      skillsDir: 'Plugins/Teams/GTM/skills',
      name: 'gtm',
      created: true,
    });
    expect(createPlugin).toHaveBeenLastCalledWith(expect.objectContaining({ id: ALICE.id }), 'GTM', 'Teams');

    const bySession = await post(base, '/api/plugins', { name: 'Ops' }, 'session-alice');
    expect(bySession.status).toBe(201);
    expect(createPlugin).toHaveBeenLastCalledWith(expect.objectContaining({ id: ALICE.id }), 'Ops', undefined);
  });

  it("my_plugin's endpoint ensures the caller's own space for a key holder", async () => {
    const base = await start();
    const res = await post(base, '/api/plugins/personal', {}, 'bevel_alice');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ path: 'Plugins/personal-user-alice', skillsDir: 'Plugins/personal-user-alice/skills' });
    expect(ensurePersonalPlugin).toHaveBeenCalledWith(expect.objectContaining({ id: ALICE.id }));
  });

  it("refuses a bad key and a bad session alike, and passes the service's refusal through with its status", async () => {
    const base = await start();
    expect((await post(base, '/api/plugins', { name: 'X' }, 'bevel_nobody')).status).toBe(401);
    expect((await post(base, '/api/plugins', { name: 'X' }, 'session-nobody')).status).toBe(401);
    createPlugin.mockRejectedValueOnce(new PluginProvisionError('There is no folder "Nope" under Plugins/.', 404));
    const refused = await post(base, '/api/plugins', { name: 'X', parent: 'Nope' }, 'bevel_alice');
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'There is no folder "Nope" under Plugins/.' });
  });
});
