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
import { TOOL_READ_ONLY_SETTING, ToolReadOnlyHints } from '../../tool-registry/read-only-hints.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { startFakeDownstreamMcpServer, type FakeDownstreamMcpServer } from './fake-downstream-mcp-server.js';

/**
 * The read-only hint as the HOSTED MCP endpoint lists it, over the real
 * Streamable-HTTP transport: the real `McpService` discovering the real agent
 * manual over loopback, with the real hints applied to it. What a client such
 * as Claude Cowork reads to decide whether a call needs approval.
 */

const KEY = 'bevel_key_interactive';
const fakeAuth: RequestHandler = (req, res, next) => {
  if ((req.headers.authorization ?? '') !== `Bearer ${KEY}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // An interactive caller (no connection-key id): the full listing, no credential filter.
  req.userId = 'user-A';
  next();
};
const pass: RequestHandler = (_req, _res, next) => next();

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
});

async function startPlatform(opts: { downstream?: FakeDownstreamMcpServer } = {}) {
  const registry = new ToolRegistry();
  registry.registerExternalTool(
    toolDef({ name: 'read_file', description: 'Read a file.', path: '/api/agent/tools/read_file', inputs: { type: 'object', properties: {} } }),
  );
  registry.registerExternalTool(
    toolDef({
      name: 'write_file',
      description: 'Write a file.',
      path: '/api/agent/tools/write_file',
      inputs: { type: 'object', properties: {} },
      tags: ['write'],
    }),
  );
  // One stored row, as the deployment-settings table would hold it.
  const row = { value: '' };
  const hints = new ToolReadOnlyHints(registry, {
    reload: async (key) => (key === TOOL_READ_ONLY_SETTING ? row.value : ''),
    recordIfAbsent: async (_key, value) => {
      if (row.value) return false;
      row.value = value;
      return true;
    },
    swapIfValue: async (_key, expected, next) => {
      if (row.value !== expected) return false;
      row.value = next ?? '';
      return true;
    },
  });

  const app = express();
  app.use(express.json());
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
        // A plugin's MCP server: a tool from the knowledge base, not the platform's.
        ...(opts.downstream
          ? [{ name: 'notion', call_template_type: 'mcp', config: { mcpServers: { srv: { transport: 'http', url: opts.downstream.url } } } }]
          : []),
      ],
    });
  });
  const httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const service = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    publicFrontendUrl: 'http://localhost:5173',
    readOnlyOverrides: () => hints.overrides(),
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(registry, pass, undefined, hints));
  stops.push(async () => {
    service.onSecretsChanged(null);
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer.close(() => r()));
  });
  return { baseUrl, hints };
}

async function connect(baseUrl: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  });
  const client = new Client({ name: 'hint-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  stops.push(() => client.close());
  return client;
}

const annotationsOf = async (client: Client) =>
  Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));

describe('the hosted MCP endpoint lists the read-only hint', () => {
  it('on every platform tool and every meta-tool, and no other annotation', async () => {
    const { baseUrl } = await startPlatform();
    expect(await annotationsOf(await connect(baseUrl))).toEqual({
      list_tools: { readOnlyHint: true },
      tools_info: { readOnlyHint: true },
      call_tool_chain: { readOnlyHint: false },
      read_file: { readOnlyHint: true },
      write_file: { readOnlyHint: false },
    });
  });

  it("lists an admin's change on the client's NEXT tools/list, with no reconnect, and a reset undoes it", async () => {
    const { baseUrl, hints } = await startPlatform();
    const client = await connect(baseUrl);
    expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: true });

    await hints.set('read_file', false, '00000000-0000-4000-8000-00000000000a');
    await hints.set('write_file', true, '00000000-0000-4000-8000-00000000000a');
    await hints.set('call_tool_chain', true, '00000000-0000-4000-8000-00000000000a');
    let listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: false });
    expect(listed.write_file).toEqual({ readOnlyHint: true });
    expect(listed.call_tool_chain).toEqual({ readOnlyHint: true });

    for (const name of ['read_file', 'write_file', 'call_tool_chain']) await hints.set(name, null, '00000000-0000-4000-8000-00000000000a');
    listed = await annotationsOf(client);
    expect(listed.read_file).toEqual({ readOnlyHint: true });
    expect(listed.write_file).toEqual({ readOnlyHint: false });
    expect(listed.call_tool_chain).toEqual({ readOnlyHint: false });
  });

  it('leaves a tool from a plugin MCP server unannotated, as before', async () => {
    const downstream = await startFakeDownstreamMcpServer();
    stops.push(() => downstream.stop());
    const { baseUrl } = await startPlatform({ downstream });
    const tools = (await (await connect(baseUrl)).listTools()).tools;
    const proxied = tools.find((t) => t.name.endsWith('echo'));
    expect(proxied).toBeDefined();
    expect(proxied).not.toHaveProperty('annotations');
  });
});
