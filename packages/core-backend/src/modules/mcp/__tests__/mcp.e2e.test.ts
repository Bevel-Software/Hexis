import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService } from '../mcp.service.js';
import { McpSessionStore } from '../mcp-session-store.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';

/**
 * True end-to-end test over the REAL Streamable-HTTP MCP transport. A real MCP
 * `Client` talks to the real `createMcpRoutes` HTTP surface, which drives the
 * real `McpService` proxy, which discovers and dispatches against the real
 * `createExternalToolsRoutes` surface over loopback — all on one express app.
 * Nothing is faked except the two auth middlewares (we're testing the transport
 * + proxy wiring, not credential verification). This is the closest automated
 * coverage to a production MCP client connecting in.
 */

const TEST_BEARER = 'bevel_e2e_testkey';

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];

// Stand-in auth: bind a user + token like the real middlewares do, accepting
// the test bearer. Used for the /mcp surface; the loopback tool endpoints are
// hosted directly below.
const fakeAuth: RequestHandler = (req, _res, next) => {
  req.userId = 'user-A';
  req.externalApiKeyId = 'tok-1';
  next();
};

async function connectClient(): Promise<Client> {
  const registry = new ToolRegistry();
  // Echo `ask` (reflects the received sessionId so continuity is observable) +
  // an erroring `boom`, registered as defs and hosted as endpoints.
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

  const app = express();
  app.use(express.json());
  app.post('/api/agent/tools/ask', (req, res) => {
    const b = (req.body ?? {}) as { prompt?: string; sessionId?: string };
    const incoming = typeof b.sessionId === 'string' ? b.sessionId : undefined;
    res.json({ text: `echo: ${b.prompt} sid=${incoming ?? 'NONE'}`, sessionId: incoming ?? 'sess-1' });
  });
  app.post('/api/agent/tools/boom', (_req, res) => res.status(500).json({ error: 'kaboom' }));

  // Listen first so we know the port, then construct the proxy pointed at our
  // own loopback address and mount the routes (Express allows post-listen use).
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const mcpService = new McpService(new McpSessionStore(), {
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(mcpService, stub, fakeAuth, fakeAuth, stub));
  app.use('/api', createManualRoutes(registry, fakeAuth));

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_BEARER}` } },
  });
  const client = new Client({ name: 'e2e-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  cleanups.push(async () => {
    await client.close();
  });
  return client;
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

describe('MCP over real Streamable-HTTP transport', () => {
  it('initializes, discovers, and lists the proxied tools with their schemas verbatim', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(['ask', 'boom', 'call_tool_chain', 'list_tools', 'tools_info']);
    // The {body} envelope the manual carries reaches the client untouched.
    expect((byName.ask.inputSchema as any).properties.body.properties.prompt).toBeDefined();
  });

  it('calls a tool end-to-end and returns the result text', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'hello' } } });
    // The whole structured result is stringified, so the answer text and the
    // returned sessionId both survive for a client without proxy auto-inject.
    const payload = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(payload.text).toBe('echo: hello sid=NONE');
    expect(payload.sessionId).toBe('sess-1');
    expect(res.isError).toBeFalsy();
  });

  it('continuity is the caller\'s: an echoed sessionId reaches the tool verbatim', async () => {
    const client = await connectClient();
    // First call: no sessionId → the tool starts a conversation and returns
    // 'sess-1' in the (fully stringified) result for the caller to read.
    const res1 = await client.callTool({ name: 'ask', arguments: { body: { prompt: 'one' } } });
    const first = JSON.parse((res1.content as Array<{ text: string }>)[0].text);
    expect(first.text).toBe('echo: one sid=NONE');
    expect(first.sessionId).toBe('sess-1');
    // Second call: the CALLER echoes the id per the tool's schema — the proxy
    // passes it through untouched, no server-side injection.
    const res2 = await client.callTool({
      name: 'ask',
      arguments: { body: { prompt: 'two', sessionId: first.sessionId } },
    });
    expect(JSON.parse((res2.content as Array<{ text: string }>)[0].text).text).toBe('echo: two sid=sess-1');
  });

  it('surfaces a downstream tool failure as an MCP isError result', async () => {
    const client = await connectClient();
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/kaboom/i);
  });
});
