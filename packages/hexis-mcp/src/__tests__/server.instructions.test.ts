import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: the agent instructions at the bridge's own handshake. The
 * faked deployment is the same surface the swap and teardown tests use (a
 * genuine stateless streamable-HTTP MCP endpoint), plus the two things this
 * feature adds: the `agentInstructions` flag on `/api/config`, and
 * `/api/agent/instructions`. A real MCP `Client` connects to the bridge's
 * `Server` over an in-memory transport and reads `getInstructions()`, which is
 * exactly what Claude Code reads.
 */

const INSTRUCTIONS = "Hexis is this organisation's knowledge base.\n\nAcme builds solar farms.";

let httpServer: http.Server | null = null;
let base = '';
/** What the faked `/api/config` says beyond the endpoint; `null` omits the field. */
let advertise: boolean | null = true;
/** What `/api/agent/instructions` answers: a status, and a body when 200. */
let instructionsAnswer: { status: number; body?: unknown } = { status: 200, body: { instructions: INSTRUCTIONS } };
let instructionsRequests = 0;

afterEach(() => {
  vi.restoreAllMocks();
  advertise = true;
  instructionsAnswer = { status: 200, body: { instructions: INSTRUCTIONS } };
  instructionsRequests = 0;
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
        if (pathname === '/api/config') {
          json(200, { mcpUrl: `${base}/api/mcp`, ...(advertise === null ? {} : { agentInstructions: advertise }) });
          return;
        }
        if (pathname === '/api/agent/instructions') {
          instructionsRequests += 1;
          if (req.headers.authorization !== 'Bearer bevel_e2e') return json(401, { error: 'nope' });
          if (instructionsAnswer.status !== 200) {
            res.writeHead(instructionsAnswer.status).end();
            return;
          }
          json(200, instructionsAnswer.body);
          return;
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as { method?: string }) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        if (pathname === '/api/agent/all-tools') return json(200, { manuals: [] });
        if (pathname === '/api/agent/tools/list_local_tools') return json(200, { tools: [] });
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

/**
 * Start the bridge, connect a real client to it, hand back what the handshake
 * said and what `tools/list` served. A failure between creating the handle
 * and returning it shuts the handle down before rethrowing: the caller has
 * nothing to close yet, and a leaked UTCP client (with, in general, its
 * spawned stdio children) outlives the test.
 */
async function handshake(): Promise<{
  instructions: string | undefined;
  toolNames: string[];
  stderr: string[];
  shutdown: () => Promise<void>;
}> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_e2e' };
  const handle = await createHexisMcpServer(config, '0.0.0');
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const shutdown = async (): Promise<void> => {
    await client.close().catch(() => {});
    await handle.shutdown();
  };
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return { instructions: client.getInstructions(), toolNames: tools.map((t) => t.name), stderr, shutdown };
  } catch (err) {
    await shutdown();
    throw err;
  }
}

describe('agent instructions at the bridge handshake', () => {
  it('carries the deployment\'s text when the config advertises the flag and the endpoint answers', { timeout: 60_000 }, async () => {
    const h = await handshake();
    try {
      expect(h.instructions).toBe(INSTRUCTIONS);
      expect(instructionsRequests).toBe(1);
      expect(h.stderr.some((l) => l.includes('predates agent instructions'))).toBe(false);
    } finally {
      await h.shutdown();
    }
  });

  it('carries none against a deployment whose config has no flag, and says so once without calling the endpoint', { timeout: 60_000 }, async () => {
    advertise = null;
    const h = await handshake();
    try {
      expect(h.instructions).toBeUndefined();
      expect(instructionsRequests).toBe(0);
      expect(h.stderr.filter((l) => l.includes('predates agent instructions'))).toHaveLength(1);
    } finally {
      await h.shutdown();
    }
  });

  it('carries none when the flag is set but the endpoint answers 500, and still serves', { timeout: 60_000 }, async () => {
    instructionsAnswer = { status: 500 };
    const h = await handshake();
    try {
      expect(h.instructions).toBeUndefined();
      expect(instructionsRequests).toBe(1);
      expect(h.stderr.some((l) => l.includes('could not fetch the agent instructions'))).toBe(true);
      // "Still serves": a real tools/list round-trip answers with the toolset.
      expect(h.toolNames).toEqual(expect.arrayContaining(['call_tool_chain', 'list_tools', 'tools_info']));
    } finally {
      await h.shutdown();
    }
  });
});
