import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallTemplate } from '@utcp/sdk';
import { McpService, type McpCaller } from '../mcp.service.js';
import { SpillStore } from '../../workspace/index.js';
import { createExternalManualReader, createManualRoutes, ToolRegistry } from '../../tool-registry/index.js';
import { toolDef } from '../../tool-helpers/index.js';

/**
 * The hosted MCP endpoint learns the tools of the manuals this server hosts
 * (the platform's own, and an inline `.tool`'s) from functions the composition
 * hands it, and not by asking its own server for them. Asserted against the
 * real service, a real UTCP client and a real MCP client.
 *
 * The loopback here still serves both manuals over HTTP and counts every
 * request for one: a discovery that went over loopback would work, and would
 * be counted. Tool CALLS still go to the loopback's tool route, which records
 * the bearer each one carried.
 */

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

const KB_MANUAL = {
  name: 'KNOWLEDGE_BASE',
  call_template_type: 'http',
  http_method: 'GET',
  url: '${API_URL}/api/agent/utcp',
  content_type: 'application/json',
  headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
} as unknown as CallTemplate;

/** An inline `.tool`'s manual template, as the manual catalog lists it. */
const inlineManual = (slug: string): CallTemplate =>
  ({
    name: slug,
    call_template_type: 'http',
    http_method: 'GET',
    url: `\${API_URL}/api/tools/${slug}/manual`,
    content_type: 'application/json',
    headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
  }) as unknown as CallTemplate;

/** A manual of one `http` tool that calls the loopback's tool route. */
const manualOf = (base: string, ...tools: string[]) => ({
  utcp_version: '1.1.0',
  manual_version: '1.0.0',
  tools: tools.map((name) => ({
    name,
    description: name,
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'POST',
      url: `${base}/api/agent/tools/read_file`,
      content_type: 'application/json',
    },
  })),
});

interface HarnessOptions {
  /** The limit on an in-process read. Absent, the service's own. */
  inProcessReadLimitMs?: number;
  /** Do not hand the endpoint the readers: it discovers over loopback, as a composition without them does. */
  overLoopback?: boolean;
}

async function harness(opts: HarnessOptions = {}) {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'read_file',
      description: 'read a file',
      path: '/api/agent/tools/read_file',
      inputs: { type: 'object', properties: { path: { type: 'string' } } },
    }),
  );
  const readFromRegistry = createExternalManualReader(registry);
  const state = {
    base: '',
    /** Requests the loopback received to discover a manual. */
    loopbackDiscoveries: [] as string[],
    /** The bearer each tool call carried to the loopback's tool route. */
    callBearers: [] as string[],
    /** Manuals listed beside the platform's. */
    manuals: [] as CallTemplate[],
    /** The bearer each in-process platform manual read was handed. */
    platformReads: [] as string[],
    /** Each in-process inline manual read: its bearer and slug. */
    inlineReads: [] as { bearer: string; slug: string }[],
    /** What the two readers do. */
    readPlatform: (async () => readFromRegistry({ userId: 'user-A' })) as (bearer: string) => Promise<unknown>,
    readInline: (async () => {
      throw new Error('no inline manual in this test');
    }) as (bearer: string, slug: string) => Promise<unknown>,
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.path === '/api/agent/utcp' || /^\/api\/tools\/[^/]+\/manual$/.test(req.path)) state.loopbackDiscoveries.push(req.path);
    next();
  });
  app.post('/api/agent/tools/read_file', (req, res) => {
    state.callBearers.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    res.json({ path: (req.body as { path?: string }).path ?? null });
  });
  app.get('/api/tools/:slug/manual', (_req, res) => res.json(manualOf(state.base, 'ping')));
  const noAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createManualRoutes(registry, noAuth));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  state.base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

  const mcp = new McpService({
    loopbackBaseUrl: state.base,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
    readCatalogRevision: async () => ({ revision: 'rev-1' }),
    readManualList: async () => ({ manuals: [KB_MANUAL, ...state.manuals] }),
    ...(opts.overLoopback
      ? {}
      : {
          readPlatformManual: (bearer: string) => {
            state.platformReads.push(bearer);
            return state.readPlatform(bearer);
          },
          readInlineManual: (bearer: string, slug: string) => {
            state.inlineReads.push({ bearer, slug });
            return state.readInline(bearer, slug);
          },
        }),
    ...(opts.inProcessReadLimitMs !== undefined ? { inProcessReadLimitMs: opts.inProcessReadLimitMs } : {}),
  });
  return { state, mcp };
}

/** One request's server, driven over an in-memory pair — the route builds one per HTTP request. */
async function connect(mcp: McpService, caller: Partial<McpCaller> = {}): Promise<Client> {
  const server = await mcp.createRequestServer(
    { userId: 'user-A', tokenId: 'key-1', connectionId: null, bearer: 'bevel_key_1', ...caller },
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

const toolNames = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const META_TOOLS = ['call_tool_chain', 'list_tools', 'tools_info'];
const withoutMeta = (names: string[]) => names.filter((n) => !META_TOOLS.includes(n)).sort();

describe('McpService — the platform manual is discovered in process', () => {
  it("lists the platform's tools from the reader, handed the caller's key, with no discovery request to the server", async () => {
    const { state, mcp } = await harness();
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['read_file']);
    expect(state.platformReads).toEqual(['bevel_key_1']);
    expect(state.loopbackDiscoveries).toEqual([]);
  });

  it('lists the same tools a discovery over loopback lists', async () => {
    const inProcess = await harness();
    const listed = await toolNames(await connect(inProcess.mcp));
    await new Promise<void>((r) => httpServer!.close(() => r()));
    const overLoopback = await harness({ overLoopback: true });
    expect(await toolNames(await connect(overLoopback.mcp))).toEqual(listed);
    expect(overLoopback.state.loopbackDiscoveries).toEqual(['/api/agent/utcp']);
  });

  // A tool is called through its own template, which still names its route and
  // carries the bearer of the request that calls it: discovery in process
  // changes how the tools are learnt, not how they are called.
  it('calls a discovered tool at its route with the bearer of the calling request, on a client built once', async () => {
    const { state, mcp } = await harness();
    const first = await connect(mcp);
    const out = await first.callTool({ name: 'read_file', arguments: { body: { path: 'a.md' } } });
    expect(JSON.stringify(out.content)).toContain('a.md');
    const second = await connect(mcp, { tokenId: 'key-2', bearer: 'bevel_key_2' });
    await second.callTool({ name: 'read_file', arguments: { body: { path: 'b.md' } } });
    expect(state.callBearers).toEqual(['bevel_key_1', 'bevel_key_2']);
    // Both keys are one person's: the second request used the first one's surface.
    expect(state.platformReads).toHaveLength(1);
  });

  // Surfaces of different people are built at the same moment, and every
  // manual of a surface registers at once. Each registration must be handed
  // its own manual, never another's.
  it('hands each of two surfaces built at once its own manual', async () => {
    const { state, mcp } = await harness();
    // Both reads answer in the same turn, so the two registrations overlap.
    state.readPlatform = async (bearer) => manualOf(state.base, bearer === 'bevel_ada' ? 'ada_tool' : 'bob_tool');
    const [ada, bob] = await Promise.all([
      connect(mcp, { userId: 'ada', tokenId: 'k-ada', bearer: 'bevel_ada' }).then(toolNames),
      connect(mcp, { userId: 'bob', tokenId: 'k-bob', bearer: 'bevel_bob' }).then(toolNames),
    ]);
    expect(withoutMeta(ada)).toEqual(['ada_tool']);
    expect(withoutMeta(bob)).toEqual(['bob_tool']);
  });

  // Over HTTP a manual's tools had to use the manual's own protocol, and the
  // client dropped any that did not. That still holds: a hosted manual cannot
  // bring in a tool that runs as a function in this process.
  it("keeps only the tools that use the manual's own protocol", async () => {
    const { state, mcp } = await harness();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.readPlatform = async () => {
      const manual = manualOf(state.base, 'read_file', 'smuggled');
      manual.tools[1]!.tool_call_template = { call_template_type: 'direct-call', callable_name: 'hexis.manual-in-hand' } as never;
      return manual;
    };
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['read_file']);
  });

  it('fails the request as a failed discovery does when the reader fails, and reads again for the next request', async () => {
    const { state, mcp } = await harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.readPlatform = async () => {
      throw new Error('the tool registry could not be read');
    };
    await expect(toolNames(await connect(mcp))).rejects.toThrow(
      "Bevel tool discovery failed: discovering tools from 'KNOWLEDGE_BASE': the tool registry could not be read",
    );
    state.readPlatform = async () => manualOf(state.base, 'read_file');
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['read_file']);
    expect(state.loopbackDiscoveries).toEqual([]);
  });

  it('words a bearer the reader refuses as the discovery request worded its 401', async () => {
    const { state, mcp } = await harness();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.readPlatform = async () => {
      // What the read throws for a refused bearer: the route's words, with its status.
      throw Object.assign(new Error('Invalid or revoked connection key.'), { status: 401 });
    };
    await expect(toolNames(await connect(mcp))).rejects.toThrow(
      "Bevel tool discovery failed: HTTP 401 discovering tools from 'KNOWLEDGE_BASE': Invalid or revoked connection key.",
    );
  });

  it('ends a read that never answers at its limit, as a failed discovery', async () => {
    const { state, mcp } = await harness({ inProcessReadLimitMs: 150 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    state.readPlatform = () => new Promise<never>(() => {});
    const started = performance.now();
    await expect(toolNames(await connect(mcp))).rejects.toThrow(/Bevel tool discovery failed: discovering tools from 'KNOWLEDGE_BASE': not finished within its 150ms limit/);
    const took = performance.now() - started;
    expect(took).toBeGreaterThanOrEqual(140);
    // Near its limit, and far from the service's own 15 seconds: a read that
    // was waited for much longer would be a request left hanging.
    expect(took).toBeLessThan(2000);
  });

  it('discovers over loopback, as before, on a request with no reader', async () => {
    const { state, mcp } = await harness({ overLoopback: true });
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['read_file']);
    expect(state.platformReads).toEqual([]);
    expect(state.loopbackDiscoveries).toEqual(['/api/agent/utcp']);
  });
});

describe("McpService — an inline `.tool`'s manual is discovered in process", () => {
  it("lists its tools from the reader, handed the caller's key and the manual's slug, with no request to the server", async () => {
    const { state, mcp } = await harness();
    state.manuals = [inlineManual('acme')];
    state.readInline = async () => manualOf(state.base, 'ping');
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['acme_ping', 'read_file']);
    expect(state.inlineReads).toEqual([{ bearer: 'bevel_key_1', slug: 'acme' }]);
    expect(state.loopbackDiscoveries).toEqual([]);
  });

  // An inline manual that cannot be read costs its own tools and nothing else:
  // the request is served, as it was when that manual's discovery failed. The
  // refusal is logged as every read in process logs one: one line, no stack.
  it('serves the request without the manual when its reader refuses it', async () => {
    const { state, mcp } = await harness();
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.manuals = [inlineManual('acme')];
    state.readInline = async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    };
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['read_file']);
    const lines = errors.mock.calls.map((c) => c.map(String).join(' '));
    expect(lines.filter((l) => l.includes("manual 'acme' refused: HTTP 404 Not found"))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('    at ');
    expect(warnings.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain(
      "skipping manual \"acme\": HTTP 404 discovering tools from 'acme': Not found",
    );
  });

  // Only a manual at one of this server's two discovery addresses is read in
  // process. A third-party `.tool` is discovered at its own address, as ever.
  it('leaves a manual hosted elsewhere to its own discovery', async () => {
    const { state, mcp } = await harness();
    state.manuals = [
      { name: 'elsewhere', call_template_type: 'http', http_method: 'GET', url: `${state.base}/api/tools/elsewhere/manual` } as unknown as CallTemplate,
    ];
    expect(withoutMeta(await toolNames(await connect(mcp)))).toEqual(['elsewhere_ping', 'read_file']);
    expect(state.inlineReads).toEqual([]);
    expect(state.loopbackDiscoveries).toEqual(['/api/tools/elsewhere/manual']);
  });
});
