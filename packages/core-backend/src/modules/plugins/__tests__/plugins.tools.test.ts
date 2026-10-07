import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { keyOrSessionAuth } from '../../tool-auth/key-or-session.middleware.js';
import { createAuthMiddleware } from '../../auth/auth.middleware.js';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { CLIENT_SHORT_CUT } from '../../tool-registry/description-length.js';
import { GUIDE_FIRST_SENTENCE } from '../../tool-registry/guide-first.js';
import { registerPluginsTools, CREATE_PLUGIN, myPluginDef, myPluginDescription } from '../plugins.tools.js';
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

/** `my_plugin` as the catalog lists it for `layout`, on the external surface. */
async function listedMyPlugin(layout = DEFAULT_KB_LAYOUT): Promise<{ description: string }> {
  const registry = new ToolRegistry();
  registerPluginsTools(registry, testKbContext({ layout }));
  const listed = (await registry.listExternal({ userEmail: ALICE.email })).find((t) => t.name === 'my_plugin');
  expect(listed, 'my_plugin is not in the external catalog').toBeDefined();
  return listed as { description: string };
}

describe('the tool definitions', () => {
  it('describe the creation endpoints, and reach every surface', async () => {
    expect((CREATE_PLUGIN.tool_call_template as { url: string }).url).toBe('${API_URL}/api/plugins');
    expect((myPluginDef(DEFAULT_KB_LAYOUT).tool_call_template as { url: string }).url).toBe(
      '${API_URL}/api/plugins/personal',
    );
    const registry = new ToolRegistry();
    registerPluginsTools(registry, testKbContext());
    for (const tools of [await registry.listExternal({ userEmail: ALICE.email }), await registry.listInternal({ userEmail: ALICE.email })]) {
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['my_plugin', 'create_plugin']));
    }
  });
});

/**
 * What `my_plugin` TELLS an agent. A personal plugin holds its owner's skills
 * and tools; nothing under the plugins root is in the knowledge graph and a
 * personal plugin is readable only by its owner, so a note filed there is
 * never found as knowledge again. The old description opened by calling the
 * folder "their personal space in the knowledge base", which read as an
 * invitation to file one. Pinned here because the text IS the change: nothing
 * refuses such a write, before or after (see the last test in this block).
 */
describe('what my_plugin tells an agent about the personal plugin', () => {
  it('states the rule, naming this deployment\'s knowledge root', async () => {
    const { description } = await listedMyPlugin();
    expect(description).toContain("The caller's personal plugin: their own skills and tools");
    expect(description).toContain('Notes, knowledge and other documents do NOT go here; they go under `KnowledgeBase/`');
    // A private request gets a QUESTION and the restrictable folder, never the
    // personal plugin — not even when the user asks for it outright.
    expect(description).toContain('ask where under `KnowledgeBase/` it should go');
    expect(description).toContain('restricted so only they can read it');
    expect(description).toContain('never write it here, even if asked');
    // The name the app shows, and none of the three phrases that sent agents here.
    for (const retired of ['personal space', 'private space', 'own space']) {
      expect(description, retired).not.toContain(retired);
    }
  });

  it('names a RENAMED knowledge root, and never the default one', async () => {
    const renamed = { knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' };
    const { description } = await listedMyPlugin(renamed);
    expect(description).toContain('they go under `Docs/`');
    expect(description).toContain('ask where under `Docs/` it should go');
    expect(description).not.toContain('KnowledgeBase');
  });

  /**
   * The save that completes first-run setup applies the names the admin just
   * chose IN THAT REQUEST, with no restart, so a description built once at
   * registration would go on naming a folder the deployment no longer has.
   * Rewritten in place, which is why both surfaces see it: they hold the same
   * object.
   */
  it('follows a layout applied after registration, on both surfaces', async () => {
    const registry = new ToolRegistry();
    const kb = testKbContext();
    registerPluginsTools(registry, kb);
    kb.applyLayout({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    for (const tools of [await registry.listExternal(), await registry.listInternal()]) {
      const description = tools.find((t) => t.name === 'my_plugin')!.description!;
      expect(description).toContain('they go under `Docs/`');
      expect(description).not.toContain('KnowledgeBase');
    }
  });

  /**
   * claude.ai cuts a tool description near `CLIENT_SHORT_CUT` characters, and
   * it counts from the guide-first sentence the registry puts in front of every
   * listed tool. So the rule has to be inside that window of the text A CLIENT
   * IS HANDED, with the `skillsDir` mechanics — which the guide states in full
   * anyway — as what a short client loses instead.
   */
  it(`states the whole rule within the first ${CLIENT_SHORT_CUT} characters a client is handed`, async () => {
    for (const layout of [DEFAULT_KB_LAYOUT, { knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' }]) {
      const { description } = await listedMyPlugin(layout);
      expect(description.startsWith(`${GUIDE_FIRST_SENTENCE} `), 'the opener is counted too').toBe(true);
      const cut = description.slice(0, CLIENT_SHORT_CUT);
      const root = layout.knowledgeBaseDir;
      for (const phrase of [
        'personal plugin',
        'their own skills and tools',
        `they go under \`${root}/\``,
        `ask where under \`${root}/\``,
        'restricted so only they can read it',
        'never write it here, even if asked',
      ]) {
        expect(cut, `"${phrase}" falls past the ${CLIENT_SHORT_CUT}-character cut`).toContain(phrase);
      }
    }
  });

  /** Only the description changed: the call an agent makes is the call it made. */
  it('keeps its endpoint, inputs, outputs and tags exactly as they were', () => {
    const def = myPluginDef(DEFAULT_KB_LAYOUT);
    expect((def.tool_call_template as { url: string; http_method: string }).url).toBe('${API_URL}/api/plugins/personal');
    expect((def.tool_call_template as { http_method: string }).http_method).toBe('POST');
    // The flat inputs are wrapped under `body` by `toolDef`; `my_plugin` takes none.
    expect(def.inputs).toEqual({
      type: 'object',
      properties: { body: { type: 'object', properties: {}, additionalProperties: false } },
      required: ['body'],
      additionalProperties: false,
    });
    expect(Object.keys((def.outputs as { properties: Record<string, unknown> }).properties)).toEqual([
      'path',
      'skillsDir',
      'folder',
      'name',
      'displayName',
      'created',
    ]);
    expect(def.tags).toEqual(['plugins', 'skills', 'write']);
    // Byte-identical on every layout but the description.
    const renamed = myPluginDef({ knowledgeBaseDir: 'Docs', skillsDir: 'Abilities', pluginsDir: 'Extensions' });
    expect({ ...renamed, description: '' }).toEqual({ ...def, description: '' });
    expect(renamed.description).not.toBe(def.description);
  });

  /** A layout given with untrimmed names is read the way every other reader reads it. */
  it('reads the layout through the same resolver the rest of the platform uses', () => {
    expect(myPluginDescription({ knowledgeBaseDir: '  Docs  ', skillsDir: 'Skills', pluginsDir: 'Plugins' })).toContain(
      '`Docs/`',
    );
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
    // A session is accepted only for an account that is on; Alice's is.
    resolveSession: async (t: string) => {
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

  it("my_plugin's endpoint ensures the caller's own personal plugin for a key holder", async () => {
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
