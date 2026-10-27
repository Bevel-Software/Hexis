import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CONNECTION_META_KEY, NOT_AVAILABLE_TO_CONNECTION } from '@bevel-software/platform-mcp-core';
import { createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: a connection made as an agent configuration, through the local
 * server. The deployment says what the connection is narrowed to on its
 * manual list and its catalog revision (`connection`), and refuses the
 * local-only tool list to a connection that loads nothing; this server
 * must carry that through — the handshake names the agent, a tool off the
 * surface is refused by name and agent rather than "unknown", and a gone
 * agent is a connection that loads nothing, not a failed discovery.
 */

const REMOTE_TOOL = 'ping_probe';
const NARROW = { agent: { path: 'Agents/narrow.agent', name: 'narrow' } };
const GONE_SENTENCE =
  'This connection was made as the agent `Agents/gone.agent`, which no longer exists or which you can no ' +
  'longer read, so it loads no tools and no skills. Reconnect and choose another agent, or Everything.';
const GONE = { agent: { path: 'Agents/gone.agent', name: 'Agents/gone.agent' }, unavailable: GONE_SENTENCE };

let httpServer: http.Server | null = null;
let base = '';
/** What the faked deployment says the connection is: Everything (undefined), narrowed, or gone. */
let connection: typeof NARROW | typeof GONE | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  connection = undefined;
});

beforeAll(async () => {
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!;
        const json = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const wire = connection ? { connection } : {};
        if (pathname === '/api/config') {
          return json(200, { mcpUrl: `${base}/api/mcp`, agentInstructions: true, catalogRevision: true });
        }
        if (pathname === '/api/agent/instructions') return json(200, { instructions: 'Read the guide first.' });
        if (pathname === '/api/agent/catalog-revision') return json(200, { revision: 'r1', tools: 0, skills: 0, ...wire });
        if (pathname === '/api/agent/all-tools') return json(200, { manuals: [], ...wire });
        if (pathname === '/api/agent/tools/list_local_tools') {
          // The deployment refuses the discovery read to a connection that loads nothing.
          if (connection && 'unavailable' in connection) {
            return json(403, { error: connection.unavailable, code: NOT_AVAILABLE_TO_CONNECTION });
          }
          return json(200, { tools: [] });
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as { method?: string }) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
              {
                name: REMOTE_TOOL,
                description: 'Exists so a real listing has something in it.',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              },
            ],
          }));
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        json(404, {});
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(httpServer!.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
});

/** The bridge, connected through a real `initialize`; `tools/list` waits for discovery. */
async function start() {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_e2e' };
  const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: false });
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  const shutdown = async (): Promise<void> => {
    await client.close().catch(() => {});
    await handle.shutdown();
  };
  return { client, stderr, shutdown };
}

/** The text parts of a tool result, joined — what the client reads. */
const text = (result: unknown) =>
  (((result as { content?: { text?: unknown }[] }).content ?? []) as { text?: unknown }[])
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n');

describe('a connection made as Everything', () => {
  it('is told nothing new, lists as before, and calls an unknown tool "unknown"', { timeout: 60_000 }, async () => {
    const { client, shutdown } = await start();
    try {
      expect(client.getInstructions()).toBe('Read the guide first.');
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(REMOTE_TOOL);
      const refused = await client.callTool({ name: 'nope', arguments: {} });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain('Unknown tool "nope"');
    } finally {
      await shutdown();
    }
  });
});

describe('a connection made as an agent configuration', () => {
  it('is told so at the handshake, and a tool off its surface is refused by name and agent', { timeout: 60_000 }, async () => {
    connection = NARROW;
    const { client, shutdown } = await start();
    try {
      expect(client.getInstructions()).toBe(
        'Read the guide first.\n\n' +
          'This connection is connected as the agent "narrow" (`Agents/narrow.agent`): it loads only the ' +
          'platform tools, connectors, skills and plugins that file lists, and of those only what you may read.',
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toContain(REMOTE_TOOL);
      const refused = await client.callTool({ name: 'nope', arguments: {} });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain(
        'The tool "nope" is not available to this connection: it is connected as the agent "narrow" (`Agents/narrow.agent`), which does not load it.',
      );
    } finally {
      await shutdown();
    }
  });
});

describe('a connection whose agent configuration is gone', () => {
  it('starts, loads nothing, and says why in the handshake, the listing and every call', { timeout: 60_000 }, async () => {
    connection = GONE;
    const { client, stderr, shutdown } = await start();
    try {
      expect(client.getInstructions()).toBe(`Read the guide first.\n\n${GONE_SENTENCE}`);
      const listed = await client.listTools();
      expect(listed.tools).toEqual([]);
      expect((listed as { _meta?: Record<string, unknown> })._meta?.[CONNECTION_META_KEY]).toBe(GONE_SENTENCE);
      const call = await client.callTool({ name: REMOTE_TOOL, arguments: {} });
      expect(call.isError).toBe(true);
      expect(text(call)).toContain(GONE_SENTENCE);
      // The refused discovery read was not a failed discovery: nothing on stderr says so.
      expect(stderr.join('\n')).not.toMatch(/could not load|discovery/i);
    } finally {
      await shutdown();
    }
  });
});
