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

async function startPlatform(opts: { downstream?: FakeDownstreamMcpServer; catalogRevision?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hosted-mcp-hints-'));
  stops.push(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repository');
  await cp(defaultKbTemplateDir(), repository, { recursive: true });
  await writeFile(join(repository, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@example.com\n');
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
        res.json({ manuals: [
          { name: 'KNOWLEDGE_BASE', call_template_type: 'http', http_method: 'GET',
            url: '${API_URL}/api/agent/utcp', content_type: 'application/json',
            headers: { Authorization: 'Bearer ${CONNECTION_KEY}' } },
          ...(opts.downstream ? [{ name: 'notion', call_template_type: 'mcp',
            config: { mcpServers: { srv: { transport: 'http', url: opts.downstream.url } } } }] : []),
        ] });
      });
      app.get('/api/agent/catalog-revision', core.manualAuthMiddleware, (_req, res) => {
        if (opts.catalogRevision) res.json({ revision: 'unchanged-catalog' });
        else res.sendStatus(404);
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
  return { baseUrl, key, setHint };
}

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

  it("lists an admin's change on the client's NEXT tools/list, with no reconnect, and a reset undoes it", async () => {
    const { baseUrl, key, setHint } = await startPlatform();
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
  });

  it("lists an admin's change and its reset on the next tools/list when the tool surface is cached", async () => {
    const { baseUrl, key, setHint } = await startPlatform({ catalogRevision: true });
    const client = await connect(baseUrl, key);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });

    await setHint('read_file', false);
    await setHint('write_file', true);
    let listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: false });
    expect(listed.write_file).toEqual({ readOnlyHint: true });

    for (const name of ['read_file', 'write_file']) await setHint(name, null);
    listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: true });
    expect(listed.write_file).toEqual({ readOnlyHint: false });
  });

  it('does not keep an override in the cached surface: one set before the surface is built is undone by its reset', async () => {
    const { baseUrl, key, setHint } = await startPlatform({ catalogRevision: true });
    await setHint('read_file', false);
    const client = await connect(baseUrl, key);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: false });

    await setHint('read_file', null);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });
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
