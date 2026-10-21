import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { createToolHandlerFactory, NOT_AVAILABLE_TO_CONNECTION } from '../../tool-helpers/tool-handler.js';
import { createToolContextResolver } from '../../tool-helpers/tool-context.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { createToolAuthMiddleware } from '../../tool-auth/tool-auth.middleware.js';
import { InternalTokenService } from '../../tool-auth/internal-token.service.js';
import type { IExternalApiKeyService } from '../../tool-auth/external-api-key.interface.js';
import { registerSkillsTools } from '../../skills/skills.tools.js';
import type { GetSkillOptions, ISkillService, ListSkillsOptions, SkillSummary } from '../../skills/skills.contract.js';
import { registerToolManualsTools } from '../../tool-manuals/tool-manuals.tools.js';
import { createToolManualsAgentRoutes } from '../../tool-manuals/tool-manuals.routes.js';
import type { ConnectorScope, IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { registerAgentGuideTool } from '../../agent-guide/agent-guide.tools.js';
import { agentFile, agentScopeOver, inMemoryKb } from './in-memory-kb.js';

/**
 * Every agent surface a connection reaches, behind the REAL auth gate, tool
 * context and tool handler, with the REAL agent-scope service over a
 * knowledge base held in memory. The credential decides the scope: a
 * connection key whose row names an `.agent` file, one that names none
 * (Everything), and one whose file is gone.
 *
 * The skill and tool-manual services are stood in for by catalogs that apply
 * the narrowing they are handed the way the real ones do — after their own
 * read gate, which here lets the reader see everything listed. (The real
 * services' read gate with a narrowing is pinned in their own suites.)
 */

const ADA = { id: 'u-ada', email: 'ada@example.com', name: 'Ada' };

const SKILLS: SkillSummary[] = [
  { name: 'notes', description: 'Release notes.', path: 'Skills/Release/notes' },
  { name: 'pitch', description: 'Sales pitch.', path: 'Skills/Sales/pitch' },
  { name: 'deploy', description: 'Deploys.', path: 'Plugins/Eng/release/skills/deploy' },
];
const MANUALS: (ToolManualSummary & { remote?: boolean })[] = [
  { slug: 'dash', name: 'dash', path: 'Plugins/Eng/release/dash.tool', type: 'http' },
  { slug: 'crm', name: 'crm', path: 'Plugins/Sales/crm.tool', type: 'http' },
  { slug: 'localgit', name: 'localgit', path: 'Plugins/Eng/release/localgit.tool', type: 'mcp', remote: false },
  { slug: 'localcrm', name: 'localcrm', path: 'Plugins/Sales/localcrm.tool', type: 'mcp', remote: false },
];

const skillService: ISkillService = {
  listSkills: async (_email?: string, o?: ListSkillsOptions) => SKILLS.filter((s) => !o?.within || o.within(s.path)),
  getSkill: async (_email: string, name: string, _file?: string, o?: GetSkillOptions) => {
    const found = SKILLS.find((s) => s.name === name);
    if (!found || (o?.within && !o.within(found.path))) return { ok: false, error: 'not_found' };
    return { ok: true, kind: 'skill', skill: { ...found, body: `# ${name}`, files: [] } };
  },
  invalidate: () => {},
};

const scoped = (within?: ConnectorScope) => MANUALS.filter((m) => !within || within(m.path));
const toolManualService = {
  listAccessibleCatalog: async (_e: string, within?: ConnectorScope) => ({ tools: scoped(within), invalid: [] }),
  listLocalOnly: async (_e: string, within?: ConnectorScope) =>
    scoped(within)
      .filter((m) => m.remote === false)
      .map((m) => ({ slug: m.slug, name: m.name, path: m.path })),
  listDeclaredOnlyOnBranch: async () => [],
  toManualCallTemplates: async (_e: string, opts?: { within?: ConnectorScope }) =>
    scoped(opts?.within)
      .filter((m) => m.remote !== false)
      .map((m) => ({ name: m.name, call_template_type: 'http', url: `https://x.example/${m.name}`, http_method: 'GET' })),
} as unknown as IToolManualService;

/** Keys by plaintext: what each one's row says it connects as. */
const KEYS: Record<string, string | null> = {
  bevel_everything: null,
  bevel_narrow: 'Agents/narrow.agent',
  bevel_plugin: 'Agents/plugin.agent',
  bevel_gone: 'Agents/gone.agent',
};

const kb = inMemoryKb(
  {
    'Agents/narrow.agent': agentFile(
      'name: narrow\nplatformTools: [list_skills, get_skill, list_tool_setup, list_local_tools, get_agent_guide]\nskills: [Skills/Release]',
    ),
    'Agents/plugin.agent': agentFile('name: release\nplugins: [Plugins/Eng]'),
  },
  { plugins: [{ folder: 'Plugins/Eng/release', linkedSkills: ['Skills/Sales/pitch'] }] },
);

let http: HttpServer | undefined;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = undefined;
});

async function start(opts: { agentScope?: boolean } = {}): Promise<string> {
  const keys = {
    looksLikeExternalApiKey: (t: string) => t.startsWith('bevel_'),
    verifyAndLoadToken: async (t: string) =>
      t in KEYS ? { tokenId: `id-${t}`, user: ADA, agentPath: KEYS[t] } : null,
  } as unknown as IExternalApiKeyService;
  const agentScope = opts.agentScope === false ? undefined : agentScopeOver(kb);
  const toolAuth = createToolAuthMiddleware(keys, new InternalTokenService({ secret: 's' }));
  const resolve = createToolContextResolver({
    authService: { getUserById: async () => ADA } as never,
    workspaceService: {} as never,
    workflowService: {} as never,
    events: {} as never,
    kbDirName: 'knowledge-base',
    creatorAccess: {} as never,
    ...(agentScope ? { agentScope } : {}),
  });
  const th = createToolHandlerFactory(resolve);
  const registry = new ToolRegistry();
  const router = express.Router();
  registerSkillsTools(registry, router, toolAuth, th, skillService);
  registerToolManualsTools(registry, router, toolAuth, th, toolManualService, {
    accessControl: { canWrite: async () => false } as never,
    variableStatus: { statusFor: async () => [] },
    kb: { defaultBranch: 'main', defaultWorkspaceId: () => 'ws-main' },
  });
  registerAgentGuideTool(registry, router, toolAuth, th, async () => [
    { id: 'introduction', title: 'Introduction', body: '## Introduction\n\nHello.' },
  ]);
  // A platform tool the narrow agent does not list.
  registry.registerExternalTool(
    toolDef({ name: 'write_file', description: 'Write.', path: '/api/agent/tools/write_file', inputs: { type: 'object', properties: {} } }),
  );
  router.post('/agent/tools/write_file', toolAuth, th(async () => ({ written: true })));
  router.use(createManualRoutes(registry, toolAuth, async () => ADA.email, agentScope));
  router.use(createToolManualsAgentRoutes(toolManualService, toolAuth, async () => ADA.email, undefined, agentScope));
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  http = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

const call = (base: string, key: string, tool: string, body: unknown = {}) =>
  fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
const get = async (base: string, key: string, path: string) =>
  (await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${key}` } })).json();

describe('Everything is byte-for-byte today’s surface', () => {
  it('every surface answers a key with no agent exactly as a deployment that cannot narrow at all', async () => {
    const narrowing = await start();
    const answers = async (base: string) => ({
      utcp: await get(base, 'bevel_everything', '/agent/utcp'),
      allTools: await get(base, 'bevel_everything', '/agent/all-tools'),
      skills: await (await call(base, 'bevel_everything', 'list_skills')).json(),
      setup: await (await call(base, 'bevel_everything', 'list_tool_setup')).json(),
      local: await (await call(base, 'bevel_everything', 'list_local_tools')).json(),
      guide: await (await call(base, 'bevel_everything', 'get_agent_guide')).json(),
      write: await (await call(base, 'bevel_everything', 'write_file')).json(),
    });
    const withScope = await answers(narrowing);
    await new Promise<void>((r) => http!.close(() => r()));
    http = undefined;
    const without = await answers(await start({ agentScope: false }));
    expect(JSON.stringify(withScope)).toBe(JSON.stringify(without));
    expect(withScope.allTools).not.toHaveProperty('connection');
    expect(withScope.guide).not.toHaveProperty('connection');
    expect((withScope.skills as { skills: unknown[] }).skills).toHaveLength(3);
  });
});

describe('a key connected as an .agent file', () => {
  it('platformTools: the manual lists only the platform tools it names', async () => {
    const base = await start();
    const names = ((await get(base, 'bevel_narrow', '/agent/utcp')) as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names.sort()).toEqual(['get_agent_guide', 'get_skill', 'list_local_tools', 'list_skills', 'list_tool_setup']);
  });

  it('a call to a platform tool outside it is refused by name and agent, before the tool runs', async () => {
    const base = await start();
    const res = await call(base, 'bevel_narrow', 'write_file');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error:
        'The tool "write_file" is not available to this connection: it is connected as the agent "narrow" ' +
        '(`Agents/narrow.agent`), which does not load it.',
      code: NOT_AVAILABLE_TO_CONNECTION,
    });
  });

  it('skills: list_skills, get_skill and the skill tools’ own descriptions name only its skills', async () => {
    const base = await start();
    const listed = (await (await call(base, 'bevel_narrow', 'list_skills')).json()) as { skills: SkillSummary[] };
    expect(listed.skills.map((s) => s.name)).toEqual(['notes']);
    expect(await (await call(base, 'bevel_narrow', 'get_skill', { name: 'pitch' })).json()).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(((await (await call(base, 'bevel_narrow', 'get_skill', { name: 'notes' })).json()) as { ok: boolean }).ok).toBe(true);
    const tools = ((await get(base, 'bevel_narrow', '/agent/utcp')) as { tools: { name: string; description: string }[] }).tools;
    const listSkills = tools.find((t) => t.name === 'list_skills')!;
    expect(listSkills.description).toContain('`notes`');
    expect(listSkills.description).not.toContain('`pitch`');
  });

  it('plugins: a plugin folder loads its connectors, its skills and the skills it links — nothing else', async () => {
    const base = await start();
    const all = (await get(base, 'bevel_plugin', '/agent/all-tools')) as {
      manuals: { name: string }[];
      connection: unknown;
    };
    expect(all.manuals.map((m) => m.name)).toEqual(['KNOWLEDGE_BASE', 'dash']);
    expect(all.connection).toEqual({ agent: { path: 'Agents/plugin.agent', name: 'release' } });
    const skills = (await (await call(base, 'bevel_plugin', 'list_skills')).json()) as { skills: SkillSummary[] };
    expect(skills.skills.map((s) => s.name).sort()).toEqual(['deploy', 'pitch']);
    // platformTools absent: every platform tool.
    expect((await call(base, 'bevel_plugin', 'write_file')).status).toBe(200);
  });

  it('list_tool_setup and list_local_tools count only the connection’s connectors', async () => {
    const base = await start();
    const setup = (await (await call(base, 'bevel_plugin', 'list_tool_setup')).json()) as { tools: { name: string }[] };
    expect(setup.tools.map((t) => t.name)).toEqual(['dash', 'localgit']);
    const local = (await (await call(base, 'bevel_plugin', 'list_local_tools')).json()) as { tools: { name: string }[] };
    expect(local.tools.map((t) => t.name)).toEqual(['localgit']);
    const narrowSetup = (await (await call(base, 'bevel_narrow', 'list_tool_setup')).json()) as { tools: unknown[] };
    expect(narrowSetup.tools).toEqual([]);
  });

  it('the agent guide opens by saying what the connection is connected as', async () => {
    const base = await start();
    const guide = (await (await call(base, 'bevel_narrow', 'get_agent_guide')).json()) as { guide: string; connection: string };
    expect(guide.connection).toContain('connected as the agent "narrow"');
    expect(guide.guide.startsWith(`> ${guide.connection}\n\n## Introduction`)).toBe(true);
  });
});

describe('a key whose .agent file is gone', () => {
  it('loads nothing — no platform tool, no connector, no skill — and every answer says why', async () => {
    const base = await start();
    expect(((await get(base, 'bevel_gone', '/agent/utcp')) as { tools: unknown[] }).tools).toEqual([]);
    const all = (await get(base, 'bevel_gone', '/agent/all-tools')) as {
      manuals: { name: string }[];
      connection: { unavailable: string };
    };
    expect(all.manuals.map((m) => m.name)).toEqual(['KNOWLEDGE_BASE']);
    expect(all.connection.unavailable).toMatch(/`Agents\/gone\.agent`, which no longer exists or which you can no longer read/);
    const res = await call(base, 'bevel_gone', 'list_skills');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(all.connection.unavailable);
  });
});
