import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { promptsForSkills, skillPromptText, type LoadedSkill, type SkillSummary } from '@bevel-software/platform-mcp-core';
import { createCoreServices, createCoreServer, stopCore, defaultKbTemplateDir, defaultStarterPacksDir, type TenantConfig } from '../../../index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, scratchDatabaseUrl, dropScratchDatabases } from '../../../__tests__/pg-scratch.js';
import { startFakeDownstreamMcpServer, type FakeDownstreamMcpServer } from './fake-downstream-mcp-server.js';
import { ConnectionScope, type IAgentScopeResolver } from '../../agent-scope/index.js';

/**
 * A client of the public server composition, over real Streamable HTTP and a
 * scratch Postgres. Tool registration, manuals, skills, hints, authentication
 * and MCP routing are the production composition. Admin edits go through the
 * public HTTP API too. The one thing a test adds is a plugin MCP server's
 * manual, appended to what the manual catalog answers (see `startPlatform`).
 */
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
}, PG_TEST_TIMEOUT);
afterAll(dropScratchDatabases, PG_TEST_TIMEOUT);

interface PlatformOptions {
  downstream?: FakeDownstreamMcpServer;
  inlineTool?: boolean;
  /**
   * Hold the event loop for this long, once, at the moment the platform's
   * tools are first being listed for a manual: a busy server, at the point
   * where a surface build waits on it.
   */
  holdLoopDuringDiscoveryMs?: number;
}

async function startPlatform(opts: PlatformOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-mcp-hints-'));
  // Retried: the graph's last git child can still be writing into the bare
  // repository for a moment after the stop, and a removal that meets it
  // fails with ENOTEMPTY (seen on CI, on several branches).
  stops.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const repository = join(root, 'repository');
  await cp(defaultKbTemplateDir(), repository, { recursive: true });
  await writeFile(join(repository, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@example.com\n');
  // Two skills. Read is default-deny, so an admin reads both and anyone else
  // reads only the one whose folder is opened to everyone.
  for (const [name, open] of [[OPEN_SKILL, true], [ADMIN_SKILL, false]] as const) {
    await mkdir(join(repository, 'Skills', name), { recursive: true });
    await writeFile(
      join(repository, 'Skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill of the test knowledge base.\n---\n\n# ${name}\n\nFollow the ${name} steps.\n`,
    );
    if (open) await writeFile(join(repository, 'Skills', name, 'access.md'), '---\nowner:\n  - Admin\n---\nread:\n  - everyone\n');
  }
  // An inline `.tool`: a manual this server hosts, whose one tool calls another
  // service. Only an admin reads it (read is default-deny).
  if (opts.inlineTool) {
    await mkdir(join(repository, 'Plugins', 'Acme'), { recursive: true });
    await writeFile(join(repository, 'Plugins', 'Acme', 'acme.tool'), INLINE_TOOL);
  }
  // Requests the server receives on the routes the endpoint used to ask itself
  // for; each still answers as the production composition does. And the times
  // the manual catalog was asked for a caller's manuals, with what it was asked.
  const hits = { manualListRoute: 0, revisionRoute: 0, skillRoutes: 0, platformManualRoute: 0, inlineManualRoute: 0 };
  const manualLists: Array<{ email: string; remoteOnly: boolean; narrowed: boolean }> = [];
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: repository });
  await git(['init', '-q', '-b', 'main']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=admin@example.com', 'commit', '-qm', 'Seed test knowledge base']);
  // Bind before constructing the graph so its loopback URL has the real port.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stops.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config: TenantConfig = {
    port, databaseUrl: await scratchDatabaseUrl('hexis_mcp_hints'), dbSchema: 'public', nodeEnv: 'test',
    tenantId: 'bevel', externalApiKeyPrefix: 'bevel_', internalTokenPrefix: 'bevel-internal_',
    uploadTokenPrefix: 'bevel-upload_', mcpOAuthTokenPrefix: 'bevel-mcp_',
    workspacesRoot: join(root, 'workspaces'), backupsRoot: join(root, 'backups'),
    spillRoot: join(root, 'spills'), agentUploadsRoot: join(root, 'uploads'), docExtractCacheRoot: join(root, 'extracts'),
    jwtSecret: 'hosted-hints-test-secret', adminEmail: 'admin@example.com', adminPassword: 'test-password',
    oidcIssuerUrl: '', oidcClientId: '', oidcClientSecret: '', oidcScopes: 'openid', oidcProviderLabel: 'SSO',
    kbRepoUrl: repository, kbDirName: 'knowledge-base', gitUsername: '', gitToken: '',
    kbTemplateDir: defaultKbTemplateDir(), starterPacksDir: defaultStarterPacksDir(),
    updateCheckEnabled: false, loginPasswordEnabled: true, allowedEmailDomains: [],
    secretsEncKey: randomBytes(32).toString('base64'), internalTokenSecret: 'hosted-hints-internal-secret',
    embedSharedSecret: '', trustProxy: '', gitTimeoutMs: 30_000,
    publicBackendUrl: baseUrl, publicFrontendUrl: baseUrl, configuredPublicFrontendUrl: baseUrl,
    settingsEnv: { KB_REPO_URL: repository, DEFAULT_BRANCH: 'main', PROTECTED_BRANCHES: 'main' },
  };
  const core = await createCoreServices(config, { mirrorSharedBindings: false, agentScope: () => agentConfigurations });
  stops.push(() => stopCore(core));
  if (opts.holdLoopDuringDiscoveryMs) {
    const registry = core.toolRegistry;
    const listExternal = registry.listExternal.bind(registry);
    let held = false;
    registry.listExternal = (ctx) => {
      if (!held) {
        held = true;
        const until = performance.now() + opts.holdLoopDuringDiscoveryMs!;
        while (performance.now() < until) {
          /* busy */
        }
      }
      return listExternal(ctx);
    };
  }
  // The manual catalog, watched: every caller's manual list is read from it,
  // by the route and by the endpoint alike, and a surface build reads it once.
  // A test's plugin MCP server is appended here, where a `.tool` would be: a
  // manual on a loopback address cannot be released into a knowledge base.
  const catalog = core.toolManualService;
  const listManuals = catalog.toManualCallTemplates.bind(catalog);
  catalog.toManualCallTemplates = async (email, listOpts) => {
    manualLists.push({ email, remoteOnly: listOpts?.remoteOnly === true, narrowed: listOpts?.within !== undefined });
    const manuals = await listManuals(email, listOpts);
    if (!opts.downstream) return manuals;
    const downstream = { name: 'notion', call_template_type: 'mcp',
      config: { mcpServers: { srv: { transport: 'http', url: opts.downstream.url } } } };
    return [...manuals, downstream as unknown as (typeof manuals)[number]];
  };
  const app = await createCoreServer(core, {
    preAuth(app) {
      // Counted and passed on: the production routes answer. The endpoint
      // reads all of these in process, so only an HTTP caller lands here.
      const counted = (hit: keyof typeof hits) => (_req: unknown, _res: unknown, next: () => void) => {
        hits[hit] += 1;
        next();
      };
      app.get('/api/agent/all-tools', counted('manualListRoute'));
      app.get('/api/agent/catalog-revision', counted('revisionRoute'));
      app.post('/api/agent/tools/list_skills', counted('skillRoutes'));
      app.post('/api/agent/tools/get_skill', counted('skillRoutes'));
      app.get('/api/agent/utcp', counted('platformManualRoute'));
      app.get('/api/tools/:slug/manual', counted('inlineManualRoute'));
    },
  }, { boot: false });
  server.on('request', app);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }),
  });
  expect(login.status).toBe(200);
  const { token, user } = await login.json() as { token: string; user: { id: string } };
  const { plaintext: key } = await core.externalApiKeyService.mint(user.id, 'metadata-test');
  const setHint = async (name: string, readOnly: boolean | null) => {
    const response = await fetch(`${baseUrl}/api/tool-hints/${name}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ readOnly }),
    });
    expect(response.status).toBe(200);
  };
  return { baseUrl, key, session: token, setHint, core, userId: user.id, hits, manualLists };
}

/** An inline `.tool` with one tool that calls another service. Nothing here calls it. */
const INLINE_TOOL = `---
name: acme
type: inline
description: The acme service.
tools:
  - name: ping
    description: Ping the acme service.
    inputs:
      type: object
      properties: {}
    outputs:
      type: object
      properties: {}
    tool_call_template:
      call_template_type: http
      http_method: GET
      url: https://api.acme.example/ping
---
`;

/** The two skills of the test knowledge base: one everyone reads, one only an admin does. */
const OPEN_SKILL = 'open-skill';
const ADMIN_SKILL = 'admin-skill';

/** A path a key is recorded with. No configuration is there, so the connection loads nothing. */
const AGENT_PATH = 'Agents/narrow.agent';

/** A configuration that IS there: it loads two platform tools and one skill. */
const READER_AGENT = 'Agents/reader.agent';
const READER_TOOLS = ['list_skills', 'read_file'];

/**
 * The distribution's part: open core owns no agent configurations, a
 * distribution supplies them (`CorePorts.agentScope`). This one knows
 * {@link READER_AGENT} and nothing else.
 */
const agentConfigurations: IAgentScopeResolver = {
  async resolve(_userEmail, agentPath) {
    if (!agentPath) return ConnectionScope.everything();
    if (agentPath !== READER_AGENT) return ConnectionScope.gone(agentPath);
    return ConnectionScope.narrowed(
      { path: READER_AGENT, name: 'reader' },
      { skills: [`Skills/${OPEN_SKILL}`], connectors: [], platformTools: READER_TOOLS },
      'reader-agent-v1',
    );
  },
  listChoices: async () => [],
  choosable: async () => null,
};

const revisionOverHttp = async (baseUrl: string, key: string) =>
  (await (await fetch(`${baseUrl}/api/agent/catalog-revision`, { headers: { Authorization: `Bearer ${key}` } })).json()) as {
    revision: string;
    connection?: unknown;
  };

async function connect(baseUrl: string, key: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'hint-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  stops.push(() => client.close());
  return client;
}

const annotationsOf = async (client: Client) =>
  Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));

describe.skipIf(!PG_ADMIN_URL)('the hosted MCP endpoint lists the read-only hint', () => {
  it('on every platform tool and every meta-tool, and no other annotation', async () => {
    const { baseUrl, key } = await startPlatform();
    const tools = (await (await connect(baseUrl, key)).listTools()).tools;
    for (const tool of tools) {
      expect(tool.title).toEqual(expect.any(String));
      expect(tool.title!.trim()).not.toBe('');
      expect(tool.annotations).toEqual({ readOnlyHint: expect.any(Boolean) });
    }
    expect(Object.fromEntries(tools.map((t) => [t.name, t.title]))).toMatchObject({
      list_tools: 'List tools',
      tools_info: 'Tools info',
      call_tool_chain: 'Call tool chain',
      read_file: 'Read file',
      write_file: 'Write file',
    });
    expect(Object.fromEntries(tools.map((t) => [t.name, t.annotations]))).toMatchObject({
      list_tools: { readOnlyHint: true },
      tools_info: { readOnlyHint: true },
      call_tool_chain: { readOnlyHint: false },
      read_file: { readOnlyHint: true },
      write_file: { readOnlyHint: false },
    });
  });

  // The endpoint reads the caller's revision in process, so on this
  // composition the tool surface is always the cached one: each of the two
  // tests below ends by showing it was built once (a build reads the caller's
  // manual list once).
  it("lists an admin's change on the client's NEXT tools/list, with no reconnect and from the cached surface, and a reset undoes it", async () => {
    const { baseUrl, key, setHint, manualLists } = await startPlatform();
    const client = await connect(baseUrl, key);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });

    await setHint('read_file', false);
    await setHint('write_file', true);
    await setHint('call_tool_chain', true);
    let listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: false });
    expect(listed.write_file).toEqual({ readOnlyHint: true });
    expect(listed.call_tool_chain).toEqual({ readOnlyHint: true });

    for (const name of ['read_file', 'write_file', 'call_tool_chain']) await setHint(name, null);
    listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: true });
    expect(listed.write_file).toEqual({ readOnlyHint: false });
    expect(listed.call_tool_chain).toEqual({ readOnlyHint: false });
    expect(manualLists).toHaveLength(1);
  });

  it('does not keep an override in the cached surface: one set before the surface is built is undone by its reset', async () => {
    const { baseUrl, key, setHint, manualLists } = await startPlatform();
    await setHint('read_file', false);
    const client = await connect(baseUrl, key);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: false });

    await setHint('read_file', null);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });
    expect(manualLists).toHaveLength(1);
  });

  it('lists a tool from a plugin MCP server with conservative effects', async () => {
    const downstream = await startFakeDownstreamMcpServer();
    stops.push(() => downstream.stop());
    const { baseUrl, key } = await startPlatform({ downstream });
    const tools = (await (await connect(baseUrl, key)).listTools()).tools;
    const proxied = tools.find((t) => t.name.endsWith('echo'));
    expect(proxied).toBeDefined();
    expect(proxied?.annotations).toEqual({ readOnlyHint: false });
  });
});

/**
 * The same composition, for where the endpoint gets a caller's catalog
 * revision: from the reader `createCoreServices` hands it, called as a
 * function, and not from `GET /api/agent/catalog-revision` on its own server.
 */
describe.skipIf(!PG_ADMIN_URL)('the hosted MCP endpoint reads the catalog revision in process', () => {
  it('sends its own revision route no request, and keeps the tool surface between requests', async () => {
    const { baseUrl, key, hits, manualLists } = await startPlatform();
    const client = await connect(baseUrl, key);
    await client.listTools();
    await client.listTools();
    await client.listTools();
    expect(hits.revisionRoute).toBe(0);
    // Built once. A request with no revision builds a surface of its own, so
    // one build over three requests is a revision that was read each time.
    expect(manualLists).toHaveLength(1);
  });

  it('answers a caller over HTTP what the reader answers in process', async () => {
    const { baseUrl, key, core, userId, hits } = await startPlatform();
    const overHttp = await revisionOverHttp(baseUrl, key);
    expect(hits.revisionRoute).toBe(1);
    expect(overHttp.revision).toMatch(/^[0-9a-f]{32}$/);
    expect(overHttp).toEqual(await core.readCatalogRevision({ userId, agentPath: null }));
    expect(overHttp.connection).toBeUndefined();
  });

  // Open core has no agent configurations of its own: a distribution supplies
  // them (`CorePorts.agentScope`). So a key recorded as an agent is told here
  // that its agent cannot be read. The sentence names the key's agent, and the
  // reader answers it only when it is asked with that agent.
  it('asks for the caller its key resolves to: a key recorded as an agent is told about that agent at the handshake', async () => {
    const { baseUrl, core, userId, hits } = await startPlatform();
    const { plaintext: agentKey } = await core.externalApiKeyService.mint(userId, 'as-an-agent', { agentPath: AGENT_PATH });
    const told = `This connection was made as the agent \`${AGENT_PATH}\`, which no longer exists or which you can no longer read`;
    const client = await connect(baseUrl, agentKey);
    expect(client.getInstructions()).toContain(told);
    expect(hits.revisionRoute).toBe(0);

    // The route resolves the same key to the same caller, and so to the same answer.
    const overHttp = await revisionOverHttp(baseUrl, agentKey);
    expect(overHttp.connection).toEqual({
      agent: { path: AGENT_PATH, name: AGENT_PATH },
      unavailable: expect.stringContaining(told),
    });
    expect(overHttp).toEqual(await core.readCatalogRevision({ userId, agentPath: AGENT_PATH }));
    expect(overHttp.revision).not.toBe((await core.readCatalogRevision({ userId, agentPath: null })).revision);

    // A key with no agent, for the same person, is told nothing of the kind.
    const { plaintext: plainKey } = await core.externalApiKeyService.mint(userId, 'everything');
    expect((await connect(baseUrl, plainKey)).getInstructions()).not.toContain('made as the agent');
  });
});

/**
 * The same composition, for the two other things the endpoint read from its
 * own server: a caller's manual list (once for every surface build) and the
 * skills behind `prompts/list` and `prompts/get`. Each is read by the code its
 * route answers with, called as a function, as the caller the request's
 * credential resolved to.
 */
describe.skipIf(!PG_ADMIN_URL)('the hosted MCP endpoint reads the manual list and the skills in process', () => {
  /** A second person, in no role: reads only what is opened to everyone. */
  const MEMBER = 'member@example.com';

  const memberKey = async (core: Awaited<ReturnType<typeof startPlatform>>['core']) => {
    const member = await core.authService.getOrCreateByEmail(MEMBER);
    return (await core.externalApiKeyService.mint(member!.id, 'member')).plaintext;
  };

  const post = (baseUrl: string, key: string, tool: string, body: unknown) =>
    fetch(`${baseUrl}/api/agent/tools/${tool}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sends its own server no request for the manual list, the revision or the skills', async () => {
    const { baseUrl, key, hits } = await startPlatform();
    const client = await connect(baseUrl, key);
    await client.listTools();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(expect.arrayContaining([OPEN_SKILL, ADMIN_SKILL]));
    const prompt = await client.getPrompt({ name: OPEN_SKILL });
    expect(JSON.stringify(prompt.messages)).toContain(`Follow the ${OPEN_SKILL} steps.`);
    expect(hits).toEqual({ manualListRoute: 0, revisionRoute: 0, skillRoutes: 0, platformManualRoute: 0, inlineManualRoute: 0 });
  });

  it('lists each caller the prompts the skill route lists them: an admin, a person in no role, and a key made as an agent', async () => {
    const { baseUrl, key: adminKey, core, userId } = await startPlatform();
    const { plaintext: agentKey } = await core.externalApiKeyService.mint(userId, 'as-an-agent', { agentPath: AGENT_PATH });
    const callers = [
      { who: 'admin', key: adminKey, narrowed: false, reads: [ADMIN_SKILL, OPEN_SKILL] },
      { who: 'member', key: await memberKey(core), narrowed: false, reads: [OPEN_SKILL] },
      // Open core reads no agent file, so this connection loads nothing: the
      // route refuses it the skills, and the endpoint lists it no prompt.
      { who: 'agent', key: agentKey, narrowed: true, reads: [] },
    ];
    for (const caller of callers) {
      const answer = await post(baseUrl, caller.key, 'list_skills', {});
      expect(answer.status, caller.who).toBe(caller.narrowed ? 403 : 200);
      const skills = caller.narrowed ? [] : ((await answer.json()) as { skills: SkillSummary[] }).skills;
      expect(skills.map((s) => s.name).sort(), caller.who).toEqual(caller.reads);

      const { prompts } = await (await connect(baseUrl, caller.key)).listPrompts();
      // The platform's own prompt is offered beside the skills on a connection
      // that is not narrowed, exactly as the shared rule says.
      expect(prompts, caller.who).toEqual(promptsForSkills(skills, !caller.narrowed));
    }
  });

  it('serves each caller the skill the skill route serves them, and refuses the one it refuses', async () => {
    const { baseUrl, key: adminKey, core } = await startPlatform();
    const member = await memberKey(core);
    for (const [who, key, name, served] of [
      ['admin', adminKey, ADMIN_SKILL, true],
      ['admin', adminKey, OPEN_SKILL, true],
      ['member', member, OPEN_SKILL, true],
      ['member', member, ADMIN_SKILL, false],
    ] as const) {
      const answer = (await (await post(baseUrl, key, 'get_skill', { name })).json()) as { ok?: boolean; skill?: LoadedSkill };
      expect(answer.ok === true, `${who} ${name}`).toBe(served);
      const client = await connect(baseUrl, key);
      if (!served) {
        await expect(client.getPrompt({ name }), `${who} ${name}`).rejects.toThrow(`Unknown skill "${name}".`);
        continue;
      }
      const prompt = await client.getPrompt({ name });
      expect(prompt.description, `${who} ${name}`).toBe(answer.skill!.description);
      expect(prompt.messages, `${who} ${name}`).toEqual([
        { role: 'user', content: { type: 'text', text: skillPromptText(answer.skill!) } },
      ]);
    }
  });

  it('reads the manual list for the caller the route reads it for, and answers what the route answers', async () => {
    const { baseUrl, key: adminKey, core, userId, manualLists } = await startPlatform();
    const { plaintext: agentKey } = await core.externalApiKeyService.mint(userId, 'as-an-agent', { agentPath: AGENT_PATH });
    const member = await core.authService.getOrCreateByEmail(MEMBER);
    const callers = [
      { who: 'admin', key: adminKey, caller: { userId, agentPath: null } },
      { who: 'member', key: await memberKey(core), caller: { userId: member!.id, agentPath: null } },
      { who: 'agent', key: agentKey, caller: { userId, agentPath: AGENT_PATH } },
    ];
    for (const { who, key, caller } of callers) {
      // The endpoint's build asks the catalog once, as this caller.
      manualLists.length = 0;
      await (await connect(baseUrl, key)).listTools();
      const [fromEndpoint, ...more] = manualLists;
      expect(more, who).toEqual([]);

      // The route asks it the same question for the same key.
      manualLists.length = 0;
      const overHttp = await (
        await fetch(`${baseUrl}/api/agent/all-tools?remote=true`, { headers: { Authorization: `Bearer ${key}` } })
      ).json();
      expect(manualLists, who).toEqual([fromEndpoint]);
      expect(fromEndpoint, who).toMatchObject({ remoteOnly: true, narrowed: who === 'agent' });

      // And the reader the endpoint calls answers what the route answered.
      expect(JSON.parse(JSON.stringify(await core.readManualList(caller, { remoteOnly: true }))), who).toEqual(overHttp);
    }
    // Three different callers were three different questions.
    expect(new Set(callers.map((c) => c.who)).size).toBe(3);
  });

  // Over loopback every read carried the bearer and its route verified it
  // again. In process the read resolves the bearer itself, with the same
  // verifier, when it reads. The request here is handed to the endpoint as its
  // route hands it over once admitted, and the key is revoked before it runs:
  // a request admitted a moment before its key was revoked.
  it('reads nothing for a key revoked after its request was admitted, as the routes answer that key', async () => {
    const { baseUrl, core, userId, hits } = await startPlatform();
    const { plaintext: key, summary } = await core.externalApiKeyService.mint(userId, 'revoked-mid-request');
    await core.externalApiKeyService.revoke(summary.id, userId);

    expect((await post(baseUrl, key, 'list_skills', {})).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/agent/all-tools`, { headers: { Authorization: `Bearer ${key}` } })).status).toBe(401);
    const routeHits = { ...hits };

    const server = await core.mcpService.createRequestServer(
      { userId, tokenId: summary.id, connectionId: null, bearer: key },
      { jsonrpc: '2.0', id: 1, method: 'prompts/list', params: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'admitted-before-the-revoke', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    stops.push(async () => {
      await client.close();
      await server.close();
    });

    // No skill is listed or served: the platform's own prompt alone.
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(['onboard']);
    await expect(client.getPrompt({ name: OPEN_SKILL })).rejects.toThrow(`Unknown skill "${OPEN_SKILL}".`);
    // No manual is listed, and the platform's own tools are refused the key
    // where they are discovered, which is the answer the request gets.
    await expect(client.listTools()).rejects.toThrow(/tool discovery failed: HTTP 401 .*Invalid or revoked connection key/);
    // All of it without a request to the list or skill routes.
    expect(hits).toEqual(routeHits);
  });

  // The revision is read on every request, and picks the cached surface. It
  // resolves the bearer too: a key revoked after its surface was built and
  // after its request was admitted is not served that surface.
  it('serves a key revoked after its request was admitted no cached surface', async () => {
    const { baseUrl, core, userId, manualLists } = await startPlatform();
    const { plaintext: key, summary } = await core.externalApiKeyService.mint(userId, 'revoked-after-a-build');
    await (await connect(baseUrl, key)).listTools();
    expect(manualLists).toHaveLength(1);
    await core.externalApiKeyService.revoke(summary.id, userId);

    const server = await core.mcpService.createRequestServer(
      { userId, tokenId: summary.id, connectionId: null, bearer: key },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'admitted-before-the-revoke', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    stops.push(async () => {
      await client.close();
      await server.close();
    });

    await expect(client.listTools()).rejects.toThrow(/tool discovery failed: HTTP 401 .*Invalid or revoked connection key/);
  });

  // The manual routes (`all-tools`, the revision, the two manuals) accept an
  // app session; the tool routes do not. Each read in process resolves the
  // bearer as the route it replaces does. The endpoint hands a read the
  // request's own bearer when the request carries a key id, so a session is
  // handed over that way here, to put the reads to the one bearer the two
  // auths answer differently.
  it('resolves the bearer as the manual routes do: an app session is served what those routes serve it', async () => {
    const { baseUrl, session, core, userId, hits, manualLists } = await startPlatform();
    expect((await fetch(`${baseUrl}/api/agent/all-tools`, { headers: { Authorization: `Bearer ${session}` } })).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/agent/utcp`, { headers: { Authorization: `Bearer ${session}` } })).status).toBe(200);
    const routeHits = { ...hits };
    manualLists.length = 0;

    const server = await core.mcpService.createRequestServer(
      { userId, tokenId: 'a-key-id', connectionId: null, bearer: session },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'session-bearer', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    stops.push(async () => {
      await client.close();
      await server.close();
    });

    expect((await client.listTools()).tools.map((t) => t.name)).toContain('read_file');
    // The list was read for the person, and nothing was asked of the routes.
    expect(manualLists).toEqual([{ email: 'admin@example.com', remoteOnly: true, narrowed: false }]);
    expect(hits).toEqual(routeHits);
  });
});

/**
 * The same composition, for the last thing the endpoint asked its own server
 * while building a surface: the tools of each manual this server hosts. The
 * platform's own manual and an inline `.tool`'s were discovered with a
 * request to `/api/agent/utcp` and `/api/tools/:slug/manual`. They are now
 * read by the code those routes answer with and handed to the tool client.
 */
describe.skipIf(!PG_ADMIN_URL)('the hosted MCP endpoint discovers the tools it hosts in process', () => {
  const toolNamesOverHttp = async (baseUrl: string, key: string) => {
    const res = await fetch(`${baseUrl}/api/agent/utcp`, { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    return ((await res.json()) as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  };

  it('lists and calls the platform tools with no discovery request to its own server', async () => {
    const { baseUrl, key, hits } = await startPlatform();
    const client = await connect(baseUrl, key);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'write_file', 'list_skills', 'call_tool_chain']));

    // A discovered tool is callable: its own template still names its route.
    const read = await client.callTool({ name: 'read_file', arguments: { body: { branch: 'main', path: 'access.md' } } });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.content)).toContain('Frontmatter governs THIS FILE');
    // And inside a chain, which calls through the same client.
    const chained = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: "const f = await KNOWLEDGE_BASE.read_file({ body: { branch: 'main', path: 'access.md' } }); return f.path;" },
    });
    expect(chained.isError).not.toBe(true);
    expect(JSON.stringify(chained.content)).toContain('knowledge-base/access.md');

    expect(hits).toEqual({ manualListRoute: 0, revisionRoute: 0, skillRoutes: 0, platformManualRoute: 0, inlineManualRoute: 0 });
  });

  it('lists each caller the platform tools the manual route lists them: an admin, a person in no role, and a key made as an agent', async () => {
    const { baseUrl, key: adminKey, core, userId } = await startPlatform();
    const member = await core.authService.getOrCreateByEmail('member@example.com');
    const { plaintext: memberKey } = await core.externalApiKeyService.mint(member!.id, 'member');
    const { plaintext: agentKey } = await core.externalApiKeyService.mint(userId, 'as-an-agent', { agentPath: AGENT_PATH });
    const { plaintext: readerKey } = await core.externalApiKeyService.mint(userId, 'as-the-reader', { agentPath: READER_AGENT });
    const META_TOOLS = ['call_tool_chain', 'list_tools', 'tools_info'];
    for (const [who, key] of [['admin', adminKey], ['member', memberKey], ['gone agent', agentKey], ['reader agent', readerKey]] as const) {
      const overHttp = await toolNamesOverHttp(baseUrl, key);
      const listed = (await (await connect(baseUrl, key)).listTools()).tools.map((t) => t.name);
      // The platform tools on the surface are the ones the route lists, by the
      // same names. The rest are the endpoint's own meta-tools.
      expect(listed.filter((n) => !META_TOOLS.includes(n)).sort(), who).toEqual(overHttp);
    }
    // And the four callers were four different answers, not one answer four times.
    expect(await toolNamesOverHttp(baseUrl, agentKey)).toEqual([]);
    expect(await toolNamesOverHttp(baseUrl, readerKey)).toEqual(READER_TOOLS);
    expect((await toolNamesOverHttp(baseUrl, adminKey)).length).toBeGreaterThan(30);
  });

  it('lists a narrowed connection the prompts of the skills its agent loads, as the skill route lists them', async () => {
    const { baseUrl, core, userId } = await startPlatform();
    const { plaintext: readerKey } = await core.externalApiKeyService.mint(userId, 'as-the-reader', { agentPath: READER_AGENT });
    const answer = await fetch(`${baseUrl}/api/agent/tools/list_skills`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readerKey}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const skills = ((await answer.json()) as { skills: SkillSummary[] }).skills;
    expect(skills.map((s) => s.name)).toEqual([OPEN_SKILL]);
    const client = await connect(baseUrl, readerKey);
    expect((await client.listPrompts()).prompts).toEqual(promptsForSkills(skills, false));
    expect(client.getInstructions()).toContain('reader');
  });

  it("discovers an inline `.tool`'s tools for the person who may read it, and not for one who may not", async () => {
    const { baseUrl, key: adminKey, core, hits } = await startPlatform({ inlineTool: true });
    const member = await core.authService.getOrCreateByEmail('member@example.com');
    const { plaintext: memberKey } = await core.externalApiKeyService.mint(member!.id, 'member');

    const forAdmin = (await (await connect(baseUrl, adminKey)).listTools()).tools.map((t) => t.name);
    expect(forAdmin.filter((n) => n.includes('acme'))).toEqual(['acme_ping']);
    const forMember = (await (await connect(baseUrl, memberKey)).listTools()).tools.map((t) => t.name);
    expect(forMember.filter((n) => n.includes('acme'))).toEqual([]);
    expect(forMember).toContain('read_file');
    expect(hits.inlineManualRoute).toBe(0);
    expect(hits.platformManualRoute).toBe(0);

    // The route still serves it, to the same people.
    const overHttp = (key: string) => fetch(`${baseUrl}/api/tools/acme/manual`, { headers: { Authorization: `Bearer ${key}` } });
    const served = await overHttp(adminKey);
    expect(served.status).toBe(200);
    expect(((await served.json()) as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(['ping']);
    expect((await overHttp(memberKey)).status).toBe(404);
  });

  // The ticket's measure. Over loopback a surface built while the event loop
  // was held failed on a limit of its own: the discovery request passed ten
  // seconds and the caller was told `tool discovery failed`.
  it(
    'answers a tools/list sent while the event loop is held for 20 seconds, once the loop is free',
    { timeout: 120_000 },
    async () => {
      // The loop is held at the moment the surface build is waiting for the
      // platform's tools: a cold build, nothing cached, and a busy server.
      const { baseUrl, key } = await startPlatform({ holdLoopDuringDiscoveryMs: 20_000 });
      const client = await connect(baseUrl, key);
      const started = performance.now();
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(performance.now() - started).toBeGreaterThanOrEqual(20_000);
      expect(names).toEqual(expect.arrayContaining(['read_file', 'call_tool_chain']));
    },
  );
});
