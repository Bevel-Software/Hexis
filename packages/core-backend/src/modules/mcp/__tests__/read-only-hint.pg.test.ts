import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCoreServices, createCoreServer, stopCore, defaultKbTemplateDir, defaultStarterPacksDir, type TenantConfig } from '../../../index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, scratchDatabaseUrl, dropScratchDatabases } from '../../../__tests__/pg-scratch.js';
import { startFakeDownstreamMcpServer, type FakeDownstreamMcpServer } from './fake-downstream-mcp-server.js';

/**
 * A client of the public server composition, over real Streamable HTTP and a
 * scratch Postgres. The catalog source is supplied through its public overlay
 * hook; tool registration, manuals, hints, authentication and MCP routing are
 * the production composition. Admin edits go through the public HTTP API too.
 */
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
}, PG_TEST_TIMEOUT);
afterAll(dropScratchDatabases, PG_TEST_TIMEOUT);

async function startPlatform(opts: { downstream?: FakeDownstreamMcpServer } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-mcp-hints-'));
  stops.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  await cp(defaultKbTemplateDir(), repository, { recursive: true });
  await writeFile(join(repository, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@example.com\n');
  // Requests the server receives on the two routes the endpoint used to ask
  // itself for. Both still answer as the production composition does.
  const hits = { allTools: 0, revisionRoute: 0 };
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
  const core = await createCoreServices(config, { mirrorSharedBindings: false });
  stops.push(() => stopCore(core));
  const app = await createCoreServer(core, {
    preAuth(app) {
      app.get('/api/agent/all-tools', core.manualAuthMiddleware, (_req, res) => {
        hits.allTools += 1;
        res.json({ manuals: [
          { name: 'KNOWLEDGE_BASE', call_template_type: 'http', http_method: 'GET',
            url: '${API_URL}/api/agent/utcp', content_type: 'application/json',
            headers: { Authorization: 'Bearer ${CONNECTION_KEY}' } },
          ...(opts.downstream ? [{ name: 'notion', call_template_type: 'mcp',
            config: { mcpServers: { srv: { transport: 'http', url: opts.downstream.url } } } }] : []),
        ] });
      });
      // Counted and passed on: the production route answers. The endpoint
      // reads the revision in process, so only an HTTP caller lands here.
      app.get('/api/agent/catalog-revision', (_req, _res, next) => {
        hits.revisionRoute += 1;
        next();
      });
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
  return { baseUrl, key, setHint, core, userId: user.id, hits };
}

/** A path a key is recorded with. No file is there: core reads none (see the last test). */
const AGENT_PATH = 'Agents/narrow.agent';

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
  // tests below ends by showing it was built once.
  it("lists an admin's change on the client's NEXT tools/list, with no reconnect and from the cached surface, and a reset undoes it", async () => {
    const { baseUrl, key, setHint, hits } = await startPlatform();
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
    expect(hits.allTools).toBe(1);
  });

  it('does not keep an override in the cached surface: one set before the surface is built is undone by its reset', async () => {
    const { baseUrl, key, setHint, hits } = await startPlatform();
    await setHint('read_file', false);
    const client = await connect(baseUrl, key);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: false });

    await setHint('read_file', null);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });
    expect(hits.allTools).toBe(1);
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
    const { baseUrl, key, hits } = await startPlatform();
    const client = await connect(baseUrl, key);
    await client.listTools();
    await client.listTools();
    await client.listTools();
    expect(hits.revisionRoute).toBe(0);
    // Built once. A request with no revision builds a surface of its own, so
    // one build over three requests is a revision that was read each time.
    expect(hits.allTools).toBe(1);
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
