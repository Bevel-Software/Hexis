import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTION_META_KEY, McpService, type McpCaller } from '../mcp.service.js';
import { SpillStore } from '../../workspace/index.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/index.js';
import type { ConnectionScopeWire } from '../../agent-scope/index.js';

/**
 * The MCP proxy's half of connecting as an agent. The surfaces behind the
 * loopback do the narrowing (pinned in the agent-scope suites); what the proxy
 * owns is the WORDING and the CACHE: a tool off a narrowed surface is refused
 * by name and agent rather than as unknown, a connection whose file is gone is
 * served an empty listing with the reason, the handshake says what the
 * connection is connected as, and two connections of one person made as
 * different agents never share a built surface.
 *
 * The loopback here answers each bearer as the agent surfaces would answer
 * that credential: `bevel_all` is Everything, `bevel_narrow` an agent that
 * loads `read_file` alone, `bevel_gone` one whose file was deleted.
 */

const NARROW: ConnectionScopeWire = { agent: { path: 'Agents/narrow.agent', name: 'narrow' } };
const GONE: ConnectionScopeWire = {
  agent: { path: 'Agents/gone.agent', name: 'Agents/gone.agent' },
  unavailable: 'This connection was made as the agent file `Agents/gone.agent`, which no longer exists.',
};
const CONNECTIONS: Record<string, ConnectionScopeWire | undefined> = {
  bevel_all: undefined,
  bevel_narrow: NARROW,
  bevel_gone: GONE,
};

let httpServer: HttpServer | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c().catch(() => {});
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  vi.restoreAllMocks();
});

async function harness() {
  const state = { builds: 0, base: '' };
  const connectionOf = (req: express.Request) => CONNECTIONS[(req.headers.authorization ?? '').replace(/^Bearer /, '')];
  const registry = new ToolRegistry();
  for (const name of ['read_file', 'edit_file']) {
    registry.registerExternalTool(
      toolDef({ name, description: name, path: `/api/agent/tools/${name}`, inputs: { type: 'object', properties: {} } }),
    );
  }
  const app = express();
  app.use(express.json());
  app.get('/api/agent/catalog-revision', (req, res) => {
    const connection = connectionOf(req);
    res.json({ revision: 'rev-1', tools: 0, skills: 0, ...(connection ? { connection } : {}) });
  });
  app.get('/api/agent/all-tools', (req, res) => {
    state.builds += 1;
    const connection = connectionOf(req);
    res.json({ manuals: [], ...(connection ? { connection } : {}) });
  });
  // The platform manual, as the agent surfaces narrow it per credential.
  app.get('/api/agent/utcp', (req, res, next) => {
    const connection = connectionOf(req);
    if (!connection) return next();
    res.json({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: connection.unavailable
        ? []
        : [
            {
              name: 'read_file',
              description: 'read_file',
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
    });
  });
  app.use('/api', createManualRoutes(registry, (_req, _res, next) => next()));
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  state.base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  const mcp = new McpService({
    loopbackBaseUrl: state.base,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
  });
  return { state, mcp };
}

async function connect(mcp: McpService, caller: Partial<McpCaller>, initialize = false): Promise<Client> {
  const message = initialize
    ? { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
    : { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const server = await mcp.createRequestServer(
    { userId: 'user-A', tokenId: 'key-1', connectionId: null, bearer: 'bevel_all', ...caller },
    message,
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

const textOf = (res: Awaited<ReturnType<Client['callTool']>>) =>
  (res.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text;

describe('a narrowed connection', () => {
  it('lists what its agent loads, and refuses another tool by name and agent — not as unknown', async () => {
    const { mcp } = await harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await connect(mcp, { bearer: 'bevel_narrow', agentPath: 'Agents/narrow.agent' });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('read_file');
    expect(names).not.toContain('edit_file');
    const refused = await client.callTool({ name: 'edit_file', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      'The tool "edit_file" is not available to this connection: it is connected as the agent "narrow" ' +
        '(`Agents/narrow.agent`), which does not load it.',
    );
  });

  it('Everything still answers an unknown tool as unknown', async () => {
    const { mcp } = await harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await connect(mcp, {});
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['read_file', 'edit_file']),
    );
    expect(textOf(await client.callTool({ name: 'nope', arguments: {} }))).toBe('Unknown tool "nope".');
  });

  it('tells the agent at the handshake what it is connected as; Everything is told what it always was', async () => {
    const { mcp } = await harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const narrowed = (await connect(mcp, { bearer: 'bevel_narrow', agentPath: 'Agents/narrow.agent' }, true)).getInstructions();
    const everything = (await connect(mcp, {}, true)).getInstructions();
    expect(narrowed).toBe(
      `${everything}\n\nThis connection is connected as the agent "narrow" (\`Agents/narrow.agent\`): it loads only the ` +
        'platform tools, connectors, skills and plugins that file lists, and of those only what you may read.',
    );
    expect(everything).not.toContain('connected as the agent');
  });

  it('two connections of one person made as different agents never share a built surface', async () => {
    const { state, mcp } = await harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await (await connect(mcp, { bearer: 'bevel_narrow', agentPath: 'Agents/narrow.agent' })).listTools();
    await (await connect(mcp, { bearer: 'bevel_narrow', agentPath: 'Agents/other.agent' })).listTools();
    await (await connect(mcp, { bearer: 'bevel_narrow', agentPath: 'Agents/narrow.agent' })).listTools();
    expect(state.builds).toBe(2);
  });
});

describe('a connection whose agent file is gone', () => {
  it('is served an empty listing carrying the reason, and every call — meta-tools too — answers it', async () => {
    const { mcp } = await harness();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await connect(mcp, { bearer: 'bevel_gone', agentPath: 'Agents/gone.agent' });
    const listed = await client.listTools();
    expect(listed.tools).toEqual([]);
    expect(listed._meta).toEqual({ [CONNECTION_META_KEY]: GONE.unavailable });
    for (const name of ['read_file', 'call_tool_chain']) {
      const res = await client.callTool({ name, arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(GONE.unavailable);
    }
    const instructions = (await connect(mcp, { bearer: 'bevel_gone', agentPath: 'Agents/gone.agent' }, true)).getInstructions();
    expect(instructions?.endsWith(GONE.unavailable!)).toBe(true);
  });
});
