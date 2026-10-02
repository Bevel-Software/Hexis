import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService } from '../mcp.service.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef, withBranchInput } from '../../tool-helpers/tool-def.js';
import { assertBranchProvided, BRANCH_REQUIRED_MESSAGE } from '../../../shared/domain-errors.js';
import { PLATFORM_HEADER } from '../../agent-instructions/index.js';

/**
 * Every Scenario of "Tool calls checked against the interface", over the real
 * MCP transport: the call example at the top of every description, the refusal
 * a call that does not match its tool gets on the direct path AND inside
 * `call_tool_chain`, and a matching call reaching its endpoint untouched.
 *
 * Two kinds of tool are in the catalog, because the whole point is that they
 * are called differently:
 *  - `ask`, a platform tool — `toolDef` wraps its arguments in `body`;
 *  - `search`, a tool a deployment adds through a manual of its own, with FLAT
 *    arguments, as every tool that calls another service has.
 */

const KEY = 'bevel_key_user_a';
const bearerOf = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');

const fakeAuth: RequestHandler = (req, res, next) => {
  if (bearerOf(req) !== KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.userId = 'user-A';
  req.externalApiKeyId = 'tok-A';
  next();
};

const passthrough: RequestHandler = (_req, _res, next) => next();

interface Platform {
  baseUrl: string;
  /** Every call the deployment's own `search` endpoint received, verbatim. */
  searchCalls: Array<{ body: unknown; query: unknown }>;
  stop(): Promise<void>;
}

const platforms: Platform[] = [];
const cleanups: Array<() => Promise<void>> = [];

async function startPlatform(): Promise<Platform> {
  const searchCalls: Platform['searchCalls'] = [];
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({
      name: 'ask',
      description: 'Ask a question.',
      path: '/api/agent/tools/ask',
      inputs: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to ask.' },
          sessionId: { type: 'string', description: 'A session to continue.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    }),
  );

  // A knowledge-base tool, with the required `branch` every one of them takes:
  // its own refusal for a missing branch must survive the argument check.
  registry.registerExternalTool(
    toolDef({
      name: 'read_file',
      description: 'Read a workspace file as text.',
      path: '/api/agent/tools/read_file',
      inputs: withBranchInput({
        type: 'object',
        properties: { path: { type: 'string', description: 'Path to read.' } },
        required: ['path'],
        additionalProperties: false,
      }),
    }),
  );

  const app = express();
  app.use(express.json());
  app.post('/api/agent/tools/ask', (req, res) => res.json({ text: `echo: ${(req.body ?? {}).prompt}` }));
  // The real boundary guard, so the refusal under test is the platform's own.
  app.post('/api/agent/tools/read_file', (req, res) => {
    try {
      assertBranchProvided((req.body ?? {}).branch);
      res.json({ path: (req.body ?? {}).path, content: 'contents' });
    } catch (err) {
      const e = err as { status?: number; message: string; payload?: Record<string, unknown> };
      res.status(e.status ?? 400).json({ error: e.message, ...(e.payload ?? {}) });
    }
  });
  // The deployment's own tool: flat arguments, like every connector tool.
  app.get('/api/third-party/manual', (_req, res) =>
    res.json({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'search',
          description: 'Search the other service.',
          inputs: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'The search text.' },
              limit: { type: 'integer', description: 'How many results.' },
            },
            required: ['query'],
            additionalProperties: false,
          },
          outputs: { type: 'object', properties: {} },
          tags: [],
          // No `body_field` named, so the default (`body`) matches no
          // argument this tool declares and every argument rides the query
          // string — the shape a connector tool really has.
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'POST',
            url: `\${API_URL}/api/third-party/search`,
            content_type: 'application/json',
          },
        },
      ],
    }),
  );
  app.post('/api/third-party/search', (req, res) => {
    searchCalls.push({ body: req.body, query: req.query });
    res.json({ hits: [] });
  });
  app.get('/api/agent/all-tools', (_req, res) => {
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
        {
          name: 'THIRD_PARTY',
          call_template_type: 'http',
          http_method: 'GET',
          url: '${API_URL}/api/third-party/manual',
          content_type: 'application/json',
        },
      ],
    });
  });

  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const service = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(registry, passthrough));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    searchCalls,
    async stop() {
      if (stopped) return;
      stopped = true;
      service.onSecretsChanged(null);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
  platforms.push(platform);
  return platform;
}

async function connect(baseUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: 'interface-e2e', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
  });
  return client;
}

const toolText = (res: { content?: unknown }) => (res.content as Array<{ text: string }>)[0].text;

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  for (const p of platforms.splice(0)) await p.stop().catch(() => {});
});

describe('every description opens with its call', () => {
  it('shows a platform tool with its arguments under `body`, and a flat tool at the top level', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(byName.ask.description?.split('\n')[0]).toBe('Call: KNOWLEDGE_BASE.ask({ body: { prompt: "..." } })');
    expect(byName.THIRD_PARTY_search.description?.split('\n')[0]).toBe('Call: THIRD_PARTY.search({ query: "..." })');
    // Every tool, the meta-tools included — an agent learns one rule, not a
    // rule with exceptions.
    for (const tool of tools) {
      expect(tool.description?.startsWith('Call: '), tool.name).toBe(true);
      expect(tool.description?.split('\n')[0].length, tool.name).toBeLessThan(200);
    }
  });

  it('keeps the call line first even for a tool that also carries the purpose prefix', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const { tools } = await client.listTools();
    // `read_file` is one of the prefixed four; this catalog has none of them,
    // so the prefix is exercised directly in the composer's own tests. What
    // this pins is that nothing in the listing path puts text ahead of the line.
    for (const tool of tools) expect(tool.description?.indexOf('Call: '), tool.name).toBe(0);
  });

  it('tells the agent to follow each tool\'s call line, and states no single shape', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const chain = (await client.listTools()).tools.find((t) => t.name === 'call_tool_chain')!;
    expect(chain.description).toContain('`Call:` line');
    expect(chain.description).toContain('NO single calling shape');
    expect(chain.description).not.toContain('Call tools as `KNOWLEDGE_BASE.<tool>({ body: { ...args } })`');
    // And the server instructions, which the handshake carries.
    expect(PLATFORM_HEADER).toContain('`Call:` line');
    expect(client.getInstructions()).toContain('`Call:` line');
  });
});

describe('a call whose arguments do not match the tool', () => {
  it('is refused with the interface and the example, and nothing is sent', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_search', arguments: { body: { query: 'x' } } });
    expect(res.isError).toBe(true);
    const text = toolText(res);
    expect(text).toContain('The arguments do not match the "search" tool.');
    expect(text).toContain('This tool takes its arguments at the top level, not under "body".');
    expect(text).toContain('"query" is required, and was not given.');
    expect(text).toContain('query (string, required) — The search text.');
    expect(text).toContain('limit (integer, optional)');
    expect(text).toContain('Call: THIRD_PARTY.search({ query: "..." })');
    expect(text).toContain('"kind":"arguments-do-not-match"');
    expect(text).toContain('"status":400');
    // The other service was never reached.
    expect(platform.searchCalls).toEqual([]);
  });

  it('names a required argument that is missing, and gives that tool\'s interface', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'ask', arguments: { body: { sessionId: 's' } } });
    expect(res.isError).toBe(true);
    const text = toolText(res);
    expect(text).toContain('"body.prompt" is required, and was not given.');
    expect(text).toContain('prompt (string, required) — What to ask.');
    expect(text).toContain('Call: KNOWLEDGE_BASE.ask({ body: { prompt: "..." } })');
  });

  it('names an argument of the wrong type', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_search', arguments: { query: 'x', limit: 'ten' } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('"limit" must be integer, but string was given.');
  });

  it('names an argument the tool does not have', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_search', arguments: { query: 'x', nope: 1 } });
    expect(res.isError).toBe(true);
    expect(toolText(res)).toContain('"nope" is not an argument of this tool.');
  });

  it('leaves a missing branch to the refusal that names it, word for word', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'read_file', arguments: { body: { path: 'a.md' } } });
    expect(res.isError).toBe(true);
    const text = toolText(res);
    expect(text).toContain(BRANCH_REQUIRED_MESSAGE);
    expect(text).toContain('"kind":"branch-required"');
    expect(text).not.toContain('arguments do not match');
  });

  it('fails the chain at that call, with the same message', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: "return THIRD_PARTY.search({ body: { query: 'x' } });" },
    });
    const text = toolText(res);
    expect(text).toContain('The arguments do not match the \\"search\\" tool.');
    expect(text).toContain('This tool takes its arguments at the top level');
    expect(platform.searchCalls).toEqual([]);
  });
});

describe('a call that matches', () => {
  it('reaches the tool with exactly the arguments that were sent', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({ name: 'THIRD_PARTY_search', arguments: { query: 'hello', limit: 2 } });
    expect(res.isError).toBeFalsy();
    expect(platform.searchCalls).toHaveLength(1);
    // Both arguments arrive, exactly as sent, in the place this tool's own
    // template puts them. Nothing was added, dropped or renamed on the way.
    expect(platform.searchCalls[0].query).toEqual({ query: 'hello', limit: '2' });
  });

  it('runs the same call from inside a chain', async () => {
    const platform = await startPlatform();
    const client = await connect(platform.baseUrl);
    const res = await client.callTool({
      name: 'call_tool_chain',
      arguments: { code: "return THIRD_PARTY.search({ query: 'chained' });" },
    });
    expect(JSON.parse(toolText(res)).result).toEqual({ hits: [] });
    expect(platform.searchCalls[0].query).toEqual({ query: 'chained' });
  });

  it('serves the example in `tools_info` too, so a chain is written from it', async () => {
    const { baseUrl } = await startPlatform();
    const client = await connect(baseUrl);
    const res = await client.callTool({ name: 'tools_info', arguments: { tool_names: ['THIRD_PARTY.search'] } });
    expect(JSON.parse(toolText(res)).interfaces).toContain('Call: THIRD_PARTY.search({ query: "..." })');
  });
});
