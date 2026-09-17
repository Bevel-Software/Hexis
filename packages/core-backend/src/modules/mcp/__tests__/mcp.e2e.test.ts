import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestHandler } from 'express';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallTemplateSerializer, UtcpClientConfigSerializer } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService } from '../mcp.service.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { PLATFORM_HEADER } from '../../agent-instructions/index.js';
import { startFakeDownstreamMcpServer, type FakeDownstreamMcpServer } from './fake-downstream-mcp-server.js';
import { registerBevelSecretsVariableLoader } from '../../secrets-vault/secrets-variable-loader.js';
import type { ForcedRefreshOutcome, ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';
import type { IToolManualService } from '../../tool-manuals/tool-manuals.contract.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger } from '../../../shared/logger.contract.js';

/**
 * True end-to-end test over the REAL Streamable-HTTP MCP transport. Real MCP
 * clients (the official SDK `Client`, and `@utcp/mcp` — the client `hexis-mcp`
 * pins) talk to the real `createMcpRoutes` HTTP surface, which drives the real
 * `McpService` proxy, which discovers and dispatches against real tool routes
 * over loopback — all on one express app per "platform process". Nothing is
 * faked except credential verification (a bearer → user map).
 *
 * The endpoint is STATELESS, so the suite's centre of gravity is what that
 * buys: no session id ever issued, every request served on its own, and a
 * platform restart between two requests of one client invisible to it.
 */

const KEY_A = 'bevel_key_user_a';
const KEY_B = 'bevel_key_user_b';
const USERS: Record<string, { userId: string; tokenId: string }> = {
  [KEY_A]: { userId: 'user-A', tokenId: 'tok-A' },
  [KEY_B]: { userId: 'user-B', tokenId: 'tok-B' },
};

const bearerOf = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

// Stand-in auth: bind the user + connection-key id for the bearer, as the real
// middleware does — per request, from that request's own header.
const fakeAuth: RequestHandler = (req, res, next) => {
  const user = USERS[bearerOf(req)];
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.userId = user.userId;
  req.externalApiKeyId = user.tokenId;
  next();
};

const passthrough: RequestHandler = (_req, _res, next) => next();

/** A tool registry: the echo `ask` + erroring `boom`, plus `extra` tools only this catalog has. */
function registryWith(extra: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'ask',
      description: 'echo the prompt',
      path: '/api/agent/tools/ask',
      inputs: {
        type: 'object',
        properties: { prompt: { type: 'string' }, sessionId: { type: 'string' } },
        required: ['prompt'],
      },
    }),
  );
  registry.registerExternalTool(
    toolDef({ name: 'boom', description: 'always errors', path: '/api/agent/tools/boom', inputs: { type: 'object', properties: {} } }),
  );
  for (const name of extra) {
    registry.registerExternalTool(
      toolDef({ name, description: name, path: `/api/agent/tools/${name}`, inputs: { type: 'object', properties: {} } }),
    );
  }
  return registry;
}

interface Platform {
  baseUrl: string;
  port: number;
  service: McpService;
  /** Loopback `ask` calls, with the bearer each one carried. */
  askCalls: Array<{ bearer: string; prompt?: string; sessionId?: string }>;
  stop(): Promise<void>;
}

interface PlatformOptions {
  /** Bind this port — how a "restarted" platform comes back at the same address. */
  port?: number;
  readAgentPreamble?: () => Promise<string | null>;
  /** Extra manuals the catalog serves each caller (beyond the KB manual). */
  manualsFor?: (bearer: string) => unknown[];
  poolNow?: () => number;
  /** The vault + manual catalog behind per-user credentials; absent ⇒ the proxy skips credential handling. */
  secretsVault?: ConstructorParameters<typeof McpService>[1];
  toolManuals?: ConstructorParameters<typeof McpService>[2];
}

const platforms: Platform[] = [];
const cleanups: Array<() => Promise<void>> = [];

/**
 * One "platform process": its own express app, its own `McpService`, nothing
 * shared with any earlier instance — which is exactly what a restart leaves.
 */
async function startPlatform(opts: PlatformOptions = {}): Promise<Platform> {
  const askCalls: Platform['askCalls'] = [];
  // Per-user catalogs: user B can see `b_only`, user A cannot.
  const routesA = createManualRoutes(registryWith([]), passthrough);
  const routesB = createManualRoutes(registryWith(['b_only']), passthrough);

  const app = express();
  app.use(express.json());
  app.post('/api/agent/tools/ask', (req, res) => {
    const b = (req.body ?? {}) as { prompt?: string; sessionId?: string };
    askCalls.push({ bearer: bearerOf(req), prompt: b.prompt, sessionId: b.sessionId });
    const incoming = typeof b.sessionId === 'string' ? b.sessionId : undefined;
    res.json({ text: `echo: ${b.prompt} sid=${incoming ?? 'NONE'}`, sessionId: incoming ?? 'sess-1' });
  });
  app.post('/api/agent/tools/boom', (_req, res) => res.status(500).json({ error: 'kaboom' }));
  app.get('/api/agent/all-tools', (req, res) => {
    res.json({
      manuals: [
        {
          name: 'KNOWLEDGE_BASE',
          call_template_type: 'http',
          http_method: 'GET',
          url: '${API_URL}/api/agent/utcp',
          content_type: 'application/json',
          headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
        },
        ...(opts.manualsFor?.(bearerOf(req)) ?? []),
      ],
    });
  });

  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(opts.port ?? 0, '127.0.0.1', () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const service = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
    readAgentPreamble: opts.readAgentPreamble,
    downstreamPool: opts.poolNow ? { now: opts.poolNow } : undefined,
  }, opts.secretsVault, opts.toolManuals);
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  // The loopback catalog is served per caller, from the bearer it carries.
  app.use('/api', (req, res, next) => (bearerOf(req) === KEY_B ? routesB : routesA)(req, res, next));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    port,
    service,
    askCalls,
    async stop() {
      if (stopped) return;
      stopped = true;
      // A pooled downstream connection belongs to this process; a restart ends it.
      service.onSecretsChanged(null);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
  platforms.push(platform);
  return platform;
}

/** Stop `platform` and bring a brand-new one up at the same address. */
async function restart(platform: Platform, opts: PlatformOptions = {}): Promise<Platform> {
  await platform.stop();
  // A real restart has downtime, during which a client's idle keep-alive
  // sockets see the close. Without this pause the test would instead measure a
  // same-tick race — a pooled socket reused before its FIN was processed —
  // that no restart produces and that has nothing to do with sessions.
  await new Promise((r) => setTimeout(r, 50));
  return startPlatform({ ...opts, port: platform.port });
}

async function connectSdkClient(baseUrl: string, bearer = KEY_A): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: 'e2e-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
  });
  return { client, transport };
}

/** One raw JSON-RPC POST; the SSE or JSON body decoded into its messages. */
async function rpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC bodies, read by shape
): Promise<{ res: Response; messages: Array<{ id?: unknown; result?: any; error?: any }> }> {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${KEY_A}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length)))
    : text
      ? [JSON.parse(text)]
      : [];
  return { res, messages };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

const toolText = (res: { content?: unknown }) => (res.content as Array<{ text: string }>)[0].text;
const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  for (const p of platforms.splice(0)) await p.stop().catch(() => {});
  vi.restoreAllMocks();
});

describe('MCP over real Streamable-HTTP transport', () => {
  it('initializes, discovers, and lists the proxied tools with their schemas verbatim', async () => {
    const { baseUrl } = await startPlatform();
    const { client } = await connectSdkClient(baseUrl);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(['ask', 'boom', 'call_tool_chain', 'list_tools', 'tools_info']);
    // The {body} envelope the manual carries reaches the client untouched.
    const askSchema = byName.ask.inputSchema as { properties: { body?: { properties?: Record<string, unknown> } } };
    expect(askSchema.properties.body?.properties?.prompt).toBeDefined();
  });

  it('calls a tool end-to-end and returns the result text', async () => {
    const { baseUrl } = await startPlatform();
    const { client } = await connectSdkClient(baseUrl);
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hello' } } });
    const payload = JSON.parse(toolText(res));
    expect(payload.text).toBe('echo: hello sid=NONE');
    expect(payload.sessionId).toBe('sess-1');
    expect(res.isError).toBeFalsy();
  });

  it('surfaces a downstream tool failure as an MCP isError result', async () => {
    const { baseUrl } = await startPlatform();
    const { client } = await connectSdkClient(baseUrl);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toMatch(/kaboom/i);
  });

  it('call_tool_chain runs against the request-built client', async () => {
    const { baseUrl } = await startPlatform();
    const { client } = await connectSdkClient(baseUrl);
    const res = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: "return KNOWLEDGE_BASE.ask({ body: { prompt: 'chain' } });" },
    });
    expect(JSON.parse(toolText(res)).result).toMatchObject({ text: 'echo: chain sid=NONE' });
  });
});

describe('stateless: no session, every request on its own', () => {
  it('initialize succeeds without ever issuing an Mcp-Session-Id', async () => {
    const { baseUrl } = await startPlatform();
    const { res, messages } = await rpc(baseUrl, INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(messages[0].result.serverInfo.name).toBe('bevel-mcp');
    // And the official client, following the server's lead, holds no session id.
    const { transport } = await connectSdkClient(baseUrl);
    expect(transport.sessionId).toBeUndefined();
  });

  it('serves tools/list and tools/call with no prior initialize at all', async () => {
    const { baseUrl } = await startPlatform();
    const list = await rpc(baseUrl, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(list.res.status).toBe(200);
    expect(list.res.headers.get('mcp-session-id')).toBeNull();
    expect(list.messages[0].result.tools.map((t: { name: string }) => t.name)).toContain('ask');

    const call = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ask', arguments: { body: { prompt: 'cold' } } },
    });
    expect(call.res.status).toBe(200);
    expect(JSON.parse(call.messages[0].result.content[0].text).text).toBe('echo: cold sid=NONE');
  });

  it('never answers "Session not found": a stale session id from before is simply ignored', async () => {
    const { baseUrl } = await startPlatform();
    const { res, messages } = await rpc(
      baseUrl,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'mcp-session-id': 'sess-from-before-the-restart' },
    );
    expect(res.status).toBe(200);
    expect(messages[0].error).toBeUndefined();
    expect(messages[0].result.tools.length).toBeGreaterThan(0);
  });

  it.each(['GET', 'DELETE'])('%s /mcp is retired with 405', async (method) => {
    const { baseUrl } = await startPlatform();
    const res = await fetch(`${baseUrl}/api/mcp`, { method, headers: { Authorization: `Bearer ${KEY_A}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

describe('a platform restart is invisible to a connected client', () => {
  it('official SDK client: the next tools/list and tools/call after a restart just work', async () => {
    const first = await startPlatform();
    const { client } = await connectSdkClient(first.baseUrl);
    expect(await toolNames(client)).toContain('ask');

    // A brand-new process at the same address: new app, new McpService, nothing carried over.
    const second = await restart(first);

    // Same client object, no re-initialize, no reconnect.
    expect(await toolNames(client)).toContain('ask');
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'after' } } });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(toolText(res)).text).toBe('echo: after sid=NONE');
    // Served by the new process, which never saw an initialize from this client.
    expect(second.askCalls).toHaveLength(1);
  });

  it("`@utcp/mcp` (hexis-mcp's client): a registered manual keeps calling across a restart", async () => {
    const first = await startPlatform();
    const client = await CodeModeUtcpClient.create(process.cwd(), new UtcpClientConfigSerializer().validateDict({}));
    cleanups.push(() => client.close());
    const registered = await client.registerManual(
      new CallTemplateSerializer().validateDict({
        name: 'hexis',
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            platform: {
              transport: 'http',
              url: `${first.baseUrl}/api/mcp`,
              headers: { Authorization: `Bearer ${KEY_A}` },
            },
          },
        },
      }),
    );
    expect(registered.success).toBe(true);
    const names = (await client.getTools()).map((t) => t.name);
    expect(names).toContain('hexis.platform.ask');

    const before = await client.callTool('hexis.platform.ask', { body: { prompt: 'one' } });
    expect(JSON.stringify(before)).toContain('echo: one');

    const second = await restart(first);
    const after = await client.callTool('hexis.platform.ask', { body: { prompt: 'two' } });
    expect(JSON.stringify(after)).toContain('echo: two');
    expect(second.askCalls.map((c) => c.prompt)).toEqual(['two']);
  });
});

describe('per-request identity: catalog, metering and continuity', () => {
  it("two users' catalogs never bleed into each other, even interleaved on one process", async () => {
    const { baseUrl } = await startPlatform();
    const { client: a } = await connectSdkClient(baseUrl, KEY_A);
    const { client: b } = await connectSdkClient(baseUrl, KEY_B);
    const [listA1, listB1] = await Promise.all([toolNames(a), toolNames(b)]);
    const [listB2, listA2] = await Promise.all([toolNames(b), toolNames(a)]);
    expect(listA1).not.toContain('b_only');
    expect(listA2).not.toContain('b_only');
    expect(listB1).toContain('b_only');
    expect(listB2).toContain('b_only');
    // A cannot call what it was not given, however recently B listed it.
    const denied = await a.callTool({ name: 'b_only', arguments: {} });
    expect(denied.isError).toBe(true);
    expect(toolText(denied)).toMatch(/Unknown tool/);
  });

  it('metering: every loopback call carries THAT request\'s connection key', async () => {
    const platform = await startPlatform();
    const { client: a } = await connectSdkClient(platform.baseUrl, KEY_A);
    const { client: b } = await connectSdkClient(platform.baseUrl, KEY_B);
    await a.callTool({ name: 'ask', arguments: { body: { prompt: 'from-a' } } });
    await b.callTool({ name: 'ask', arguments: { body: { prompt: 'from-b' } } });
    await a.callTool({ name: 'ask', arguments: { body: { prompt: 'from-a-again' } } });
    expect(platform.askCalls.map((c) => [c.prompt, c.bearer])).toEqual([
      ['from-a', KEY_A],
      ['from-b', KEY_B],
      ['from-a-again', KEY_A],
    ]);
  });

  it("`ask` continuity rides the tool's own sessionId — across a restart too", async () => {
    const first = await startPlatform();
    const { client } = await connectSdkClient(first.baseUrl);
    const res1 = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'one' } } });
    const { sessionId } = JSON.parse(toolText(res1));
    expect(sessionId).toBe('sess-1');

    const second = await restart(first);
    const res2 = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'two', sessionId } } });
    expect(JSON.parse(toolText(res2)).text).toBe('echo: two sid=sess-1');
    expect(second.askCalls[0].sessionId).toBe('sess-1');
  });
});

describe('agent instructions over the real transport', () => {
  it('the initialize result carries the header and the preamble body inline', async () => {
    const { baseUrl } = await startPlatform({
      readAgentPreamble: async () => 'Acme builds solar farms.\n\n<!-- private -->Look in Projects/ first.',
    });
    const { client } = await connectSdkClient(baseUrl);
    const instructions = client.getInstructions();
    expect(instructions).toBe(`${PLATFORM_HEADER}\n\nAcme builds solar farms.\n\nLook in Projects/ first.`);
    expect(instructions).not.toContain('private');
  });

  it('a later initialize on the SAME process after the file changed carries the new text — read per request', async () => {
    let content = 'Version one.';
    const { baseUrl } = await startPlatform({ readAgentPreamble: async () => content });
    const { client: first } = await connectSdkClient(baseUrl);
    expect(first.getInstructions()).toContain('Version one.');

    content = 'Version two.';
    const { client: second } = await connectSdkClient(baseUrl);
    expect(second.getInstructions()).toContain('Version two.');
    expect(second.getInstructions()).not.toContain('Version one.');
    // The first client keeps the instructions it was initialised with.
    expect(first.getInstructions()).toContain('Version one.');
  });
});

describe('proxied third-party MCP servers: the downstream pool', () => {
  let downstream: FakeDownstreamMcpServer | undefined;
  afterEach(async () => {
    await downstream?.stop();
    downstream = undefined;
  });

  /** A catalog that gives every caller one `mcp.json`-style manual at the fake server. */
  const withDownstream = (server: FakeDownstreamMcpServer) => () => [
    { name: 'notion', call_template_type: 'mcp', config: { mcpServers: { srv: { transport: 'http', url: server.url } } } },
  ];

  const echoName = async (client: Client) => {
    const name = (await client.listTools()).tools.map((t) => t.name).find((n) => n.endsWith('echo'));
    expect(name).toBeDefined();
    return name!;
  };

  it('lists and calls a proxied tool, reusing ONE downstream connection across requests', async () => {
    downstream = await startFakeDownstreamMcpServer();
    const { baseUrl } = await startPlatform({ manualsFor: withDownstream(downstream) });
    const { client } = await connectSdkClient(baseUrl);
    const name = await echoName(client);
    for (const text of ['one', 'two', 'three']) {
      const res = await client.callTool({ name, arguments: { text } });
      expect(res.isError).toBeFalsy();
      expect(toolText(res)).toContain(text);
    }
    // Four requests (list + three calls), one handshake.
    expect(downstream.initializations()).toBe(1);
    expect(downstream.executions()).toBe(3);
  });

  it('single-flight: concurrent first calls to one server produce one connection', async () => {
    downstream = await startFakeDownstreamMcpServer();
    const { baseUrl } = await startPlatform({ manualsFor: withDownstream(downstream) });
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        rpc(baseUrl, { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'notion_srv_echo', arguments: { text: `c${i}` } } }),
      ),
    );
    for (const { res } of results) expect(res.status).toBe(200);
    expect(downstream.initializations()).toBe(1);
  });

  it('pools per (user, server): another user gets a connection of their own, even for an identical definition', async () => {
    downstream = await startFakeDownstreamMcpServer();
    // The same server definition for both users, with no per-user credential
    // in it — the case where nothing but the pool boundary keeps them apart.
    const { baseUrl } = await startPlatform({ manualsFor: withDownstream(downstream) });
    const { client: a } = await connectSdkClient(baseUrl, KEY_A);
    const { client: b } = await connectSdkClient(baseUrl, KEY_B);
    await a.callTool({ name: await echoName(a), arguments: { text: 'a' } });
    await b.callTool({ name: await echoName(b), arguments: { text: 'b' } });
    // Each pooled client owns its own `mcp` protocol instance, so each user's
    // entry dials its own session: a second initialization, not a shared one.
    expect(downstream.initializations()).toBe(2);
  });

  it('recovery pass-through: a downstream restart is healed on the next call', async () => {
    downstream = await startFakeDownstreamMcpServer();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { baseUrl } = await startPlatform({ manualsFor: withDownstream(downstream) });
    const { client } = await connectSdkClient(baseUrl);
    const name = await echoName(client);
    await client.callTool({ name, arguments: { text: 'before' } });

    await downstream.restart(); // the downstream forgets our session

    const res = await client.callTool({ name, arguments: { text: 'after' } });
    expect(res.isError).toBeFalsy();
    expect(toolText(res)).toContain('after');
    expect(downstream.initializations()).toBe(2);
  });

  it('an mcp.json edited after a failure is tried on the next request, not after the failure memo expires', async () => {
    downstream = await startFakeDownstreamMcpServer();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let url = 'http://127.0.0.1:1/mcp'; // nothing listens: registration fails and is memoized
    const { baseUrl } = await startPlatform({
      manualsFor: () => [
        { name: 'notion', call_template_type: 'mcp', config: { mcpServers: { srv: { transport: 'http', url } } } },
      ],
    });
    const { client } = await connectSdkClient(baseUrl);
    expect((await client.listTools()).tools.some((t) => t.name.endsWith('echo'))).toBe(false);

    url = downstream.url; // the user corrects the definition
    await echoName(client);
    expect(downstream.initializations()).toBe(1);
  });

  it('idle eviction: an entry unused past the TTL is closed and re-dialed lazily', async () => {
    downstream = await startFakeDownstreamMcpServer();
    let now = 1_000_000;
    const { baseUrl } = await startPlatform({ manualsFor: withDownstream(downstream), poolNow: () => now });
    const { client } = await connectSdkClient(baseUrl);
    const name = await echoName(client);
    await client.callTool({ name, arguments: { text: 'x' } });
    expect(downstream.initializations()).toBe(1);

    now += 4 * 60 * 60 * 1000 + 1; // past the default 4h idle TTL
    const res = await client.callTool({ name, arguments: { text: 'y' } });
    expect(res.isError).toBeFalsy();
    expect(downstream.initializations()).toBe(2);
  });
});

describe('proxied third-party MCP servers: a rejected token gets one refresh and a retry', () => {
  let downstream: FakeDownstreamMcpServer | undefined;
  let restoreLogger: ILogger | undefined;
  afterEach(async () => {
    await downstream?.stop();
    downstream = undefined;
    registerBevelSecretsVariableLoader(null as unknown as ISecretsVaultService);
    if (restoreLogger) setLogger(restoreLogger);
    restoreLogger = undefined;
  });

  const KEY = 'notion_ACCESS_TOKEN';

  /**
   * One user's stored OAuth sign-in for the `notion` manual, as the proxy sees
   * it through the vault contract: `resolve` hands out the current token, and
   * `forceRefresh` does what the test scripts — rotate it, wipe it (a dead
   * grant), or leave it (a provider outage).
   */
  function fakeSignIn(initialToken: string, onRefresh: (s: { token: string | null }) => ForcedRefreshOutcome) {
    const state = { token: initialToken as string | null, refreshes: 0 };
    const vault = {
      resolve: async (_userId: string, key: string) => (key === KEY ? state.token : null),
      statusFor: async (_userId: string, keys: string[]) =>
        keys.map((key) => ({ key, adminConfigured: false, userConfigured: true, userAuthorized: state.token !== null })),
      forceRefresh: async (_userId: string, key: string) => {
        expect(key).toBe(KEY);
        state.refreshes += 1;
        return onRefresh(state);
      },
    } as unknown as ISecretsVaultService;
    registerBevelSecretsVariableLoader(vault);
    const toolManuals = {
      userScopedKeysForManual: async (manual: string) =>
        manual === 'notion' ? [{ key: KEY, name: 'ACCESS_TOKEN', label: 'Notion sign-in', oauth: true }] : [],
    } as unknown as IToolManualService;
    return { state, vault, toolManuals };
  }

  const notionManual = (server: FakeDownstreamMcpServer) => () => [
    {
      name: 'notion',
      call_template_type: 'mcp',
      config: {
        mcpServers: { srv: { transport: 'http', url: server.url, headers: { Authorization: 'Bearer ${ACCESS_TOKEN}' } } },
      },
    },
  ];

  /** Every log line, flattened to text, so a test can assert what was — and was not — written. */
  function captureLogs(): string[] {
    const lines: string[] = [];
    const capture = (bindings: Record<string, unknown>): ILogger => {
      const write = (message: string, fields?: Record<string, unknown>) =>
        lines.push(JSON.stringify({ ...bindings, message, fields }, (_k, v) => (v instanceof Error ? v.message : v)));
      return { debug: write, info: write, warn: write, error: write, child: (more) => capture({ ...bindings, ...more }) };
    };
    restoreLogger = setLogger(capture({}));
    return lines;
  }
  const refreshLines = (lines: string[]) => lines.filter((l) => l.includes('downstream token refresh'));

  const quiet = () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  };

  it('reproduction: a deliberately invalid stored token is refreshed at the handshake and the tool works', async () => {
    quiet();
    let valid = 'fresh-token';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    const { state, vault, toolManuals } = fakeSignIn('deliberately-invalid-token', (s) => {
      s.token = valid;
      return 'refreshed';
    });
    const logs = captureLogs();
    const { baseUrl } = await startPlatform({ manualsFor: notionManual(downstream), secretsVault: vault, toolManuals });
    const { client } = await connectSdkClient(baseUrl);

    const res = await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'hello' } });

    expect(res.isError).toBeFalsy();
    expect(toolText(res)).toContain('hello');
    expect(state.refreshes).toBe(1);
    expect(downstream.rejections()).toBeGreaterThan(0);
    expect(refreshLines(logs)).toHaveLength(1);
    expect(refreshLines(logs)[0]).toContain('manual=notion user=user-A outcome=refreshed');
    valid = 'unused';
  });

  it('401 → refresh → retry: a token revoked mid-life is refreshed and the call succeeds; the caller sees only that', async () => {
    quiet();
    let valid = 'token-1';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    const { state, vault, toolManuals } = fakeSignIn('token-1', (s) => {
      s.token = 'token-2';
      return 'refreshed';
    });
    const { baseUrl } = await startPlatform({ manualsFor: notionManual(downstream), secretsVault: vault, toolManuals });
    const { client } = await connectSdkClient(baseUrl);
    expect(toolText(await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'one' } }))).toContain('one');
    expect(downstream.initializations()).toBe(1);

    valid = 'token-2'; // the provider revokes token-1 before its stated expiry

    const res = await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'two' } });
    expect(res.isError).toBeFalsy();
    expect(toolText(res)).toContain('two');
    expect(state.refreshes).toBe(1);
    expect(downstream.executions()).toBe(2); // the refused attempt ran nothing
    expect(downstream.initializations()).toBe(2); // the retry dialed with the fresh token
  });

  it('refresh rejected → token wiped → status not connected → the answer says to re-authorize on /connect', async () => {
    quiet();
    let valid = 'token-1';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    const { state, vault, toolManuals } = fakeSignIn('token-1', (s) => {
      s.token = null; // the vault wipes a dead grant
      return 'rejected';
    });
    const logs = captureLogs();
    const { baseUrl } = await startPlatform({ manualsFor: notionManual(downstream), secretsVault: vault, toolManuals });
    const { client } = await connectSdkClient(baseUrl);
    await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'one' } });

    valid = 'nothing-valid-any-more';

    const res = await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'two' } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('Your sign-in for "notion" was rejected and has been disconnected');
    expect(toolText(res)).toContain('Re-authorize it on http://localhost:5173/connect');
    expect(state.refreshes).toBe(1);
    expect((await vault.statusFor('user-A', [KEY]))[0]?.userAuthorized).toBe(false);
    expect(refreshLines(logs)[0]).toContain('manual=notion user=user-A outcome=rejected');
  });

  it('transient refresh failure: the original error comes back, the token is kept, and a later call tries again', async () => {
    quiet();
    let now = 1_000_000;
    let valid = 'token-1';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    let providerUp = false;
    const { state, vault, toolManuals } = fakeSignIn('token-1', (s) => {
      if (!providerUp) return 'transient';
      s.token = 'token-2';
      return 'refreshed';
    });
    const logs = captureLogs();
    const { baseUrl } = await startPlatform({
      manualsFor: notionManual(downstream),
      secretsVault: vault,
      toolManuals,
      poolNow: () => now,
    });
    const { client } = await connectSdkClient(baseUrl);
    await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'one' } });

    valid = 'token-2';

    const failed = await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'two' } });
    expect(failed.isError).toBe(true);
    expect(toolText(failed)).toContain('invalid_token'); // the downstream's own refusal, unchanged
    expect(toolText(failed)).not.toContain('Re-authorize');
    expect(state.token).toBe('token-1'); // kept
    expect(refreshLines(logs)[0]).toContain('outcome=transient');

    providerUp = true;
    now += 60_000;
    const later = await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'three' } });
    expect(later.isError).toBeFalsy();
    expect(state.refreshes).toBe(2);
  });

  it('once per minute: a grant the downstream keeps refusing cannot loop the provider', async () => {
    quiet();
    let now = 1_000_000;
    let valid = 'token-1';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    // The provider happily refreshes; the downstream refuses whatever comes back.
    const { state, vault, toolManuals } = fakeSignIn('token-1', (s) => {
      s.token = `token-${s.token}-next`;
      return 'refreshed';
    });
    const { baseUrl } = await startPlatform({
      manualsFor: notionManual(downstream),
      secretsVault: vault,
      toolManuals,
      poolNow: () => now,
    });
    const { client } = await connectSdkClient(baseUrl);
    await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'one' } });

    valid = 'never';
    for (let i = 0; i < 4; i++) {
      const res = await client.callTool({ name: 'notion_srv_echo', arguments: { text: `x${i}` } });
      expect(res.isError).toBe(true);
      now += 10_000;
    }
    // Four refused calls inside the minute, one refresh. (The window reopening
    // is the guard's own test; here the manual-failure memo additionally keeps
    // a manual that failed to register from being re-dialed for a while.)
    expect(state.refreshes).toBe(1);
  });

  it('logs one line per refresh attempt — manual, user, outcome — and never the token', async () => {
    quiet();
    let valid = 'secret-token-OLD';
    downstream = await startFakeDownstreamMcpServer({ acceptsToken: (t) => t === valid });
    const { vault, toolManuals } = fakeSignIn('secret-token-OLD', (s) => {
      s.token = 'secret-token-NEW';
      return 'refreshed';
    });
    const logs = captureLogs();
    const { baseUrl } = await startPlatform({ manualsFor: notionManual(downstream), secretsVault: vault, toolManuals });
    const { client } = await connectSdkClient(baseUrl);
    await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'one' } });
    valid = 'secret-token-NEW';
    await client.callTool({ name: 'notion_srv_echo', arguments: { text: 'two' } });

    expect(refreshLines(logs)).toEqual([expect.stringContaining('manual=notion user=user-A outcome=refreshed')]);
    for (const line of logs) {
      expect(line).not.toContain('secret-token-OLD');
      expect(line).not.toContain('secret-token-NEW');
    }
  });
});

// A measurement, not a regression gate: it asserts nothing about latency, so it
// runs only on request (`MCP_PERF=1`) instead of spending ~40 loopback calls on
// every CI run.
describe.runIf(process.env.MCP_PERF === '1')('per-request overhead (reported, not asserted)', () => {
  it('measures tools/list and tools/call latency against a warm process', async () => {
    const { baseUrl } = await startPlatform();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { client } = await connectSdkClient(baseUrl);
    await client.listTools(); // warm-up

    const time = async (fn: () => Promise<unknown>, runs = 20) => {
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        await fn();
        samples.push(performance.now() - t0);
      }
      samples.sort((x, y) => x - y);
      // Nearest-rank percentile: the smallest sample with at least p% of samples at or below it.
      const pct = (p: number) => samples[Math.min(runs - 1, Math.max(0, Math.ceil(runs * p) - 1))]!;
      return { p50: pct(0.5), p95: pct(0.95) };
    };
    const list = await time(() => client.listTools());
    const call = await time(() => client.callTool({ name: 'ask', arguments: { body: { prompt: 'perf' } } }));
    log.mockRestore();
    console.log(
      `[mcp perf] per-request (in-process loopback, test catalog): ` +
        `tools/list p50=${list.p50.toFixed(1)}ms p95=${list.p95.toFixed(1)}ms; ` +
        `tools/call p50=${call.p50.toFixed(1)}ms p95=${call.p95.toFixed(1)}ms`,
    );
    expect(list.p50).toBeGreaterThan(0);
  });
});
