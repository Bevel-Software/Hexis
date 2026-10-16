import type { Server as HttpServer } from 'node:http';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallTemplate } from '@utcp/sdk';
import { McpService, type McpCaller } from '../mcp.service.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import type { AgentEventInput } from '../../audit/audit.contract.js';
import type { SurfaceCacheOptions } from '../surface-cache.js';

/**
 * The hosted MCP server keeps one tool client per person, caller kind, key
 * scope and catalog revision — asserted against the REAL service, a real
 * loopback (the registry-driven KB manual, a catalog and a revision route), a
 * real UTCP client and a real MCP client, with nothing faked but the data.
 *
 * A build is counted where it starts: the one `GET /api/agent/all-tools` it
 * makes. Two requests that make one such call between them were served by
 * one build.
 *
 * What each tool call carried is recorded at the loopback: the bearer, so a
 * cached client can be seen to carry the CALLING request's credential and no
 * other's.
 */

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

interface HarnessOptions {
  auditRecorder?: { record: (e: AgentEventInput) => void };
  surfaceCache?: SurfaceCacheOptions;
  /** A delay on the catalog fetch, standing in for a slow knowledge base. */
  catalogDelayMs?: number;
  /** Filler tools on the KB manual, and the size of each one's description (the heap test). */
  fillerTools?: { count: number; descriptionBytes: number };
  /** A minting internal-token service, for OAuth/session callers. */
  mint?: () => string;
}

async function harness(opts: HarnessOptions = {}) {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'read_file',
      description: 'read a file',
      path: '/api/agent/tools/read_file',
      inputs: { type: 'object', properties: { path: { type: 'string' }, delayMs: { type: 'number' } } },
    }),
  );
  registry.registerExternalTool(
    toolDef({
      name: 'edit_file',
      description: 'edit a file',
      path: '/api/agent/tools/edit_file',
      write: true,
      inputs: { type: 'object', properties: { path: { type: 'string' } } },
    }),
  );
  const filler = opts.fillerTools;
  for (let i = 0; i < (filler?.count ?? 0); i++) {
    registry.registerExternalTool(
      toolDef({
        name: `filler_${i}`,
        description: `filler ${i} `.padEnd(filler!.descriptionBytes, 'lorem ipsum dolor sit amet '),
        path: `/api/agent/tools/filler_${i}`,
        inputs: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 12 }, (_, j) => [`field_${j}`, { type: 'string', description: `field ${j} of filler ${i}` }]),
          ),
        },
      }),
    );
  }

  const state = {
    builds: 0,
    revision: 'rev-1',
    extraManuals: [] as CallTemplate[],
    /** Bearers the loopback refuses, as a revoked key is. */
    refused: new Set<string>(),
    /** Every tool call the loopback answered: which tool, with which bearer. */
    calls: [] as { tool: string; bearer: string; path?: string }[],
    base: '',
  };
  const bearerOf = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer /, '');

  const app = express();
  app.use(express.json());
  app.get('/api/agent/catalog-revision', (_req, res) => {
    res.json({ revision: state.revision, tools: state.extraManuals.length, skills: 0 });
  });
  app.get('/api/agent/all-tools', async (_req, res) => {
    state.builds += 1;
    if (opts.catalogDelayMs) await new Promise((r) => setTimeout(r, opts.catalogDelayMs));
    res.json({ manuals: state.extraManuals });
  });
  for (const tool of ['read_file', 'edit_file']) {
    app.post(`/api/agent/tools/${tool}`, async (req, res) => {
      const bearer = bearerOf(req);
      if (state.refused.has(bearer)) {
        res.status(401).json({ error: 'This connection key was revoked.' });
        return;
      }
      const body = (req.body ?? {}) as { path?: string; delayMs?: number };
      if (body.delayMs) await new Promise((r) => setTimeout(r, body.delayMs));
      state.calls.push({ tool, bearer, path: body.path });
      res.json({ tool, path: body.path, bearer });
    });
  }
  app.get('/api/test/late-manual', (_req, res) =>
    res.json({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'late_arrival',
          description: 'released after the first request',
          inputs: { type: 'object', properties: {} },
          outputs: { type: 'object', properties: {} },
          tags: [],
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'POST',
            url: `${state.base}/api/agent/tools/read_file`,
            content_type: 'application/json',
          },
        },
      ],
    }),
  );
  const noAuth: express.RequestHandler = (_req, _res, next) => next();
  app.use('/api', createManualRoutes(registry, noAuth));
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  state.base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;

  const makeService = () =>
    new McpService(
      {
        loopbackBaseUrl: state.base,
        manualName: 'KNOWLEDGE_BASE',
        spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
        publicFrontendUrl: 'http://localhost:5173',
        surfaceCache: opts.surfaceCache,
      },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts.mint ? ({ mint: opts.mint } as any) : undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opts.auditRecorder as any,
    );
  return { state, mcp: makeService(), makeService };
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

/** A tool result's JSON payload. */
function payload(res: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const content = res.content as Array<{ type: string; text?: string }>;
  return JSON.parse(content.find((c) => c.type === 'text')!.text!) as Record<string, unknown>;
}

async function readFile(client: Client, path: string, delayMs?: number) {
  return client.callTool({ name: 'read_file', arguments: { body: { path, ...(delayMs ? { delayMs } : {}) } } });
}

const lateManual = (base: string): CallTemplate =>
  ({ name: 'late_manual', call_template_type: 'http', url: `${base}/api/test/late-manual`, http_method: 'GET' }) as CallTemplate;

describe('McpService — one tool client per person and catalog revision', () => {
  it('serves a second request of the same person from the first one\'s build, in the time of the listing alone', async () => {
    const { state, mcp } = await harness({ catalogDelayMs: 400 });
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = await connect(mcp);
    const coldStart = performance.now();
    const coldList = (await first.listTools()).tools.map((t) => t.name);
    const cold = performance.now() - coldStart;

    const second = await connect(mcp);
    const warmStart = performance.now();
    const warmList = (await second.listTools()).tools.map((t) => t.name);
    const warm = performance.now() - warmStart;

    expect(warmList).toEqual(coldList);
    expect(state.builds).toBe(1);
    expect(cold).toBeGreaterThanOrEqual(400);
    // No catalog fetch, no registration, no discovery: the listing alone.
    expect(warm).toBeLessThan(200);
    // The surface log shows one build for the two requests.
    const surfaceLines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('request surface:'));
    expect(surfaceLines).toHaveLength(1);
    expect(surfaceLines[0]).toContain('cache=miss');
  });

  it('answers a tool call on a warm client in the tool\'s own time', async () => {
    const { state, mcp } = await harness({ catalogDelayMs: 400 });
    await (await connect(mcp)).listTools();
    const started = performance.now();
    const res = await readFile(await connect(mcp), 'KnowledgeBase/Foo.md');
    expect(payload(res)).toMatchObject({ path: 'KnowledgeBase/Foo.md' });
    expect(performance.now() - started).toBeLessThan(200);
    expect(state.builds).toBe(1);
  });

  it('builds a new client when the catalog revision moves, and the request answers from the new catalog', async () => {
    const { state, mcp } = await harness();
    const before = (await (await connect(mcp)).listTools()).tools.map((t) => t.name);
    expect(before.some((n) => n.includes('late_arrival'))).toBe(false);

    // A `.tool` lands on the default branch: the catalog lists it and the
    // revision moves with it.
    state.extraManuals = [lateManual(state.base)];
    state.revision = 'rev-2';
    const after = (await (await connect(mcp)).listTools()).tools.map((t) => t.name);
    expect(after.some((n) => n.includes('late_arrival'))).toBe(true);
    expect(state.builds).toBe(2);

    // Taken out of the person's reach again: the next request is back without it.
    state.extraManuals = [];
    state.revision = 'rev-3';
    const removed = await connect(mcp);
    expect((await removed.listTools()).tools.some((t) => t.name.includes('late_arrival'))).toBe(false);
    // Called by name anyway, it is refused as an unknown tool — not served from the old surface.
    const res = await removed.callTool({ name: 'late_manual_late_arrival', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('Unknown tool');
    expect(state.builds).toBe(3);
  });

  it("rebuilds a person's client after one of their secrets changes, and everyone's after a shared one does", async () => {
    const { state, mcp } = await harness();
    await (await connect(mcp, { userId: 'user-A' })).listTools();
    await (await connect(mcp, { userId: 'user-B', tokenId: 'key-B', bearer: 'bevel_key_B' })).listTools();
    expect(state.builds).toBe(2);

    mcp.onSecretsChanged('user-A');
    await (await connect(mcp, { userId: 'user-A' })).listTools();
    await (await connect(mcp, { userId: 'user-B', tokenId: 'key-B', bearer: 'bevel_key_B' })).listTools();
    expect(state.builds).toBe(3); // A rebuilt, B still warm

    mcp.onSecretsChanged(null);
    await (await connect(mcp, { userId: 'user-A' })).listTools();
    await (await connect(mcp, { userId: 'user-B', tokenId: 'key-B', bearer: 'bevel_key_B' })).listTools();
    expect(state.builds).toBe(5);
  });

  it('drops a client unused for an hour and holds no more than the cap, least recently used first', async () => {
    let now = 1_000_000;
    const { state, mcp } = await harness({ surfaceCache: { maxEntries: 2, now: () => now } });
    const asUser = (u: string) => connect(mcp, { userId: u, tokenId: `key-${u}`, bearer: `bevel_${u}` });

    await (await asUser('a')).listTools();
    now += 59 * 60 * 1000;
    await (await asUser('a')).listTools();
    expect(state.builds).toBe(1); // used within the hour: still warm
    now += 60 * 60 * 1000;
    await (await asUser('a')).listTools();
    expect(state.builds).toBe(2); // an hour unused: dropped and rebuilt

    await (await asUser('b')).listTools();
    now += 1;
    await (await asUser('a')).listTools(); // `a` used last; `b` is now the oldest
    await (await asUser('c')).listTools(); // the cap: `b` goes
    expect(state.builds).toBe(4);
    await (await asUser('a')).listTools();
    expect(state.builds).toBe(4);
    await (await asUser('b')).listTools();
    expect(state.builds).toBe(5);
  });

  it('keeps a client per caller kind: a connection key and the same person\'s session never share one', async () => {
    let minted = 0;
    const { state, mcp } = await harness({ mint: () => `minted-${++minted}` });
    await (await connect(mcp)).listTools();
    await (await connect(mcp, { tokenId: null, bearer: 'eyJ.session' })).listTools();
    expect(state.builds).toBe(2);
  });

  it('carries each request\'s own bearer: two keys of one person on one warm client are each their own, and a revoked one fails alone', async () => {
    const recorded: AgentEventInput[] = [];
    const { state, mcp } = await harness({ auditRecorder: { record: (e) => recorded.push(e) } });
    const keyOne = await connect(mcp, { tokenId: 'key-1', bearer: 'bevel_key_1' });
    const keyTwo = await connect(mcp, { tokenId: 'key-2', bearer: 'bevel_key_2' });

    expect(payload(await readFile(keyOne, 'a.md')).bearer).toBe('bevel_key_1');
    expect(payload(await readFile(keyTwo, 'b.md')).bearer).toBe('bevel_key_2');
    expect(state.builds).toBe(1);
    expect(recorded.map((e) => e.principal)).toEqual([
      { kind: 'key', id: 'key-1' },
      { kind: 'key', id: 'key-2' },
    ]);

    // Key 2 is revoked: its next request is refused at the loopback, key 1's
    // next request keeps working on the same warm client.
    state.refused.add('bevel_key_2');
    const revoked = await readFile(await connect(mcp, { tokenId: 'key-2', bearer: 'bevel_key_2' }), 'c.md');
    expect(revoked.isError).toBe(true);
    expect(payload(await readFile(await connect(mcp, { tokenId: 'key-1', bearer: 'bevel_key_1' }), 'd.md')).bearer).toBe(
      'bevel_key_1',
    );
    expect(state.builds).toBe(1);
  });

  it('uses the token minted for THIS request, so a page open past one token\'s lifetime keeps working', async () => {
    let minted = 0;
    const { state, mcp } = await harness({ mint: () => `minted-${++minted}` });
    const session = { tokenId: null, bearer: 'eyJ.session' };
    expect(payload(await readFile(await connect(mcp, session), 'a.md')).bearer).toBe('minted-1');
    // The first token expires (the loopback refuses it); the next request mints its own.
    state.refused.add('minted-1');
    expect(payload(await readFile(await connect(mcp, session), 'b.md')).bearer).toBe('minted-2');
    expect(state.builds).toBe(1);
  });

  it('answers two calls of one person at the same moment, each with its own result and its own key', async () => {
    const recorded: AgentEventInput[] = [];
    const { state, mcp } = await harness({ auditRecorder: { record: (e) => recorded.push(e) } });
    await (await connect(mcp)).listTools();
    const one = await connect(mcp, { tokenId: 'key-1', bearer: 'bevel_key_1' });
    const two = await connect(mcp, { tokenId: 'key-2', bearer: 'bevel_key_2' });

    const [a, b, chainA, chainB] = await Promise.all([
      readFile(one, 'one.md', 60),
      readFile(two, 'two.md', 20),
      one.callTool({
        name: 'call_tool_chain',
        arguments: { code: "return KNOWLEDGE_BASE.read_file({ body: { path: 'chain-one.md', delayMs: 40 } });" },
      }),
      two.callTool({
        name: 'call_tool_chain',
        arguments: { code: "return KNOWLEDGE_BASE.read_file({ body: { path: 'chain-two.md', delayMs: 10 } });" },
      }),
    ]);
    expect(payload(a)).toMatchObject({ path: 'one.md', bearer: 'bevel_key_1' });
    expect(payload(b)).toMatchObject({ path: 'two.md', bearer: 'bevel_key_2' });
    expect(JSON.stringify(chainA.content)).toContain('chain-one.md');
    expect(JSON.stringify(chainA.content)).toContain('bevel_key_1');
    expect(JSON.stringify(chainB.content)).toContain('chain-two.md');
    expect(JSON.stringify(chainB.content)).toContain('bevel_key_2');
    expect(state.builds).toBe(1);

    // Each chain's inner call is audited once, under the key of the request that ran it.
    const inner = recorded.filter((e) => e.name === 'read_file');
    expect(inner).toHaveLength(4);
    const byKey = (id: string) => inner.filter((e) => e.principal.kind === 'key' && e.principal.id === id).length;
    expect(byKey('key-1')).toBe(2);
    expect(byKey('key-2')).toBe(2);
  });

  it('is invisible across a restart: a new process builds on its first request and answers as before', async () => {
    const { state, mcp, makeService } = await harness();
    const before = (await (await connect(mcp)).listTools()).tools.map((t) => t.name);
    const restarted = makeService();
    const after = (await (await connect(restarted)).listTools()).tools.map((t) => t.name);
    expect(after).toEqual(before);
    expect(payload(await readFile(await connect(restarted), 'a.md'))).toMatchObject({ path: 'a.md' });
    expect(state.builds).toBe(2);
  });

  it('builds per request when the revision cannot be read, never serving a surface it cannot tell is current', async () => {
    const { state, mcp } = await harness();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.revision = '';
    await (await connect(mcp)).listTools();
    await (await connect(mcp)).listTools();
    expect(state.builds).toBe(2);
  });

  it('holds one copy of the tool definitions for every client of the same catalog', async () => {
    const { mcp } = await harness({ fillerTools: { count: 5, descriptionBytes: 200 } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Surface = { client: any };
    const surfaces = (mcp as unknown as { surfaces: { peek(k: string): Promise<Surface | undefined>; keys(): string[] } }).surfaces;
    await (await connect(mcp, { userId: 'user-A' })).listTools();
    await (await connect(mcp, { userId: 'user-B', tokenId: 'key-B' })).listTools();
    const [a, b] = await Promise.all(surfaces.keys().map((k) => surfaces.peek(k)));
    const toolOf = async (s: Surface | undefined) =>
      (await s!.client.config.tool_repository.getTool('KNOWLEDGE_BASE.filler_0')) as { inputs: unknown; description: string };
    expect(a!.client).not.toBe(b!.client);
    // Different clients, different shells — the same definition underneath.
    expect((await toolOf(a)).inputs).toBe((await toolOf(b)).inputs);
    // And no client keeps the bearer of the request that built it.
    const templates = JSON.stringify(await a!.client.config.tool_repository.getManualCallTemplates());
    expect(templates).not.toContain('bevel_key_1');
  });
});

describe('McpService — a broken tool server', () => {
  it('keeps the client for the hour: a manual that fails to load is no reason to rebuild every minute', async () => {
    let now = 1_000_000;
    const { state, mcp } = await harness({ surfaceCache: { now: () => now } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A `.tool` whose server does not answer: it fails at every build.
    state.extraManuals = [
      { name: 'down_server', call_template_type: 'http', url: 'http://127.0.0.1:1/manual', http_method: 'GET' } as CallTemplate,
    ];
    const first = (await (await connect(mcp)).listTools()).tools.map((t) => t.name);
    expect(first).toContain('read_file');
    expect(first.some((n) => n.startsWith('down_server'))).toBe(false);
    now += 70_000;
    await (await connect(mcp)).listTools();
    now += 50 * 60 * 1000;
    await (await connect(mcp)).listTools();
    expect(state.builds).toBe(1);

    // What mends it reaches the cache: the admin sets the missing secret.
    mcp.onSecretsChanged(null);
    await (await connect(mcp)).listTools();
    expect(state.builds).toBe(2);
  });
});

describe('McpService — retained heap of warm clients of one catalog', () => {
  it('grows by less than 100 KB per client beyond the first, across 300 people', { timeout: 600_000 }, async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    // A catalog whose definitions alone are ~240 KB: held per client, 300
    // clients would be ~70 MB, and the bound below could not hold. A dozen
    // large tools rather than many small ones: the bytes are what is
    // measured, and each tool costs every build a schema check, which under a
    // loaded suite is the difference between seconds and minutes.
    const { mcp } = await harness({ fillerTools: { count: 12, descriptionBytes: 20_000 } });
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        gc();
        await new Promise((r) => setTimeout(r, 10));
      }
      return process.memoryUsage().heapUsed;
    };
    const warm = async (i: number) => {
      const client = await connect(mcp, { userId: `user-${i}`, tokenId: `key-${i}`, bearer: `bevel_${i}` });
      await client.listTools();
      // The request's server and MCP client go; the cached surface stays.
      for (const c of cleanups.splice(0)) await c().catch(() => {});
    };
    await warm(0);
    const base = await settle();
    for (let i = 1; i < 300; i++) await warm(i);
    const grown = (await settle()) - base;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((mcp as any).surfaces.size).toBe(300);
    expect(grown / 299).toBeLessThan(100 * 1024);
  });
});

describe("McpService — a page's calls in the Audit log", () => {
  const PAGE = 'Dashboards/Roadmap.html';

  it('records every call a page makes under the viewer, with the page\'s path as the agent', async () => {
    const recorded: AgentEventInput[] = [];
    let minted = 0;
    const { mcp } = await harness({ auditRecorder: { record: (e) => recorded.push(e) }, mint: () => `minted-${++minted}` });
    const page = await connect(mcp, { userId: 'user-A', tokenId: null, bearer: 'eyJ.session', page: PAGE });
    await readFile(page, 'KnowledgeBase/Foo.md');
    await page.callTool({ name: 'edit_file', arguments: { body: { path: 'KnowledgeBase/Bar.md' } } });
    expect(recorded.map((e) => [e.userId, e.principal, e.name, e.outcome])).toEqual([
      ['user-A', { kind: 'page', path: PAGE }, 'read_file', 'ok'],
      ['user-A', { kind: 'page', path: PAGE }, 'edit_file', 'ok'],
    ]);

    // The same person's session without a page records nothing, as before.
    await readFile(await connect(mcp, { userId: 'user-A', tokenId: null, bearer: 'eyJ.session' }), 'x.md');
    expect(recorded).toHaveLength(2);
  });

  it('records a call the viewer refused as refused, named as the page called it', async () => {
    const recorded: AgentEventInput[] = [];
    const { mcp } = await harness({ auditRecorder: { record: (e) => recorded.push(e) }, mint: () => 'minted' });
    await mcp.recordPageRefusal({ userId: 'user-A', bearer: 'eyJ.session' }, PAGE, 'edit_file', { body: { path: 'a.md' } });
    await mcp.recordPageRefusal({ userId: 'user-A', bearer: 'eyJ.session' }, PAGE, 'call_tool_chain', { code: 'return 1' });
    expect(recorded.map((e) => [e.principal, e.kind, e.name, e.outcome])).toEqual([
      [{ kind: 'page', path: PAGE }, 'capability', 'edit_file', 'refused'],
      [{ kind: 'page', path: PAGE }, 'capability', 'call_tool_chain', 'refused'],
    ]);
  });
});
