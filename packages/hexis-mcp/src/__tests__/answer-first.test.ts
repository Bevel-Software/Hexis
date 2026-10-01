import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DISCOVERY_NOTICE_TOOL, createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: the bridge ANSWERS FIRST and DISCOVERS AFTER.
 *
 * The bug this pins is a timeout, so the test has to be about ordering rather
 * than about speed on this machine: the faked deployment HOLDS its manual list
 * until the test lets go, which is a discovery that takes as long as the test
 * says it does — exactly the cold `npx` start (dependency tree, then one
 * archive per plugin, then a spawned server each) that used to run before the
 * transport was connected at all.
 *
 * With that held, a real MCP `Client` still completes its handshake, and the
 * `tools/list` behind it waits and then answers with the real catalog. A third
 * case fails discovery outright and reads what the client is told: a server
 * that stayed up and said why, not a silent exit.
 *
 * The stub is the same surface `server.instructions.test.ts` uses (a genuine
 * stateless streamable-HTTP MCP endpoint, so registration is real), plus a
 * gate and a switchable failure on `/api/agent/all-tools`.
 */

/** The one tool the faked deployment serves, so a real listing has something in it. */
const REMOTE_TOOL = 'ping_probe';

let httpServer: http.Server | null = null;
let base = '';
/** Held by the test: `/api/agent/all-tools` does not answer until this resolves. */
let manualsGate: Promise<void> = Promise.resolve();
let releaseManuals: () => void = () => {};
/** Flipped by the test when it lets discovery through, so "still held" is assertable. */
let manualsReleased = true;
/** How many times discovery has actually reached the deployment. */
let manualsRequests = 0;
/** When set, `/api/agent/all-tools` answers with this status instead of a list. */
let manualsFailWith: number | null = null;

function holdManuals(): void {
  manualsReleased = false;
  manualsGate = new Promise<void>((resolve) => {
    releaseManuals = () => {
      manualsReleased = true;
      resolve();
    };
  });
}

/** Poll until `predicate` holds, or fail the test with `what` at the deadline. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  // Module-level stub state must not leak between tests.
  releaseManuals();
  manualsGate = Promise.resolve();
  manualsReleased = true;
  manualsRequests = 0;
  manualsFailWith = null;
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
          json(200, { mcpUrl: `${base}/api/mcp`, agentInstructions: false });
          return;
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
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({
            content: [{ type: 'text' as const, text: 'pong' }],
          }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, parsed);
          return;
        }
        if (pathname === '/api/agent/all-tools') {
          manualsRequests += 1;
          // THE SLOW PART, under the test's control. Everything expensive about
          // a cold start hangs off this list.
          await manualsGate;
          if (manualsFailWith !== null) return json(manualsFailWith, { error: 'the deployment is having a day' });
          return json(200, { manuals: [] });
        }
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

/** Start the bridge with stderr captured, and a client wired but not connected. */
async function start(): Promise<{
  handle: Awaited<ReturnType<typeof createHexisMcpServer>>;
  client: Client;
  connect: () => Promise<void>;
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
  const connect = async (): Promise<void> => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport); // this IS the `initialize` round trip
  };
  return { handle, client, connect, stderr, shutdown };
}

describe('the bridge answers its client before discovery finishes', () => {
  it('completes `initialize` while the deployment is still withholding the catalog', { timeout: 60_000 }, async () => {
    holdManuals();
    const s = await start();
    try {
      // Discovery has genuinely started and is genuinely stuck: without this
      // the handshake below could be fast for the boring reason.
      await waitFor(() => manualsRequests > 0, 'discovery to reach the deployment');

      const began = Date.now();
      await s.connect();
      const handshakeMs = Date.now() - began;

      // The claim, in the order that matters: the handshake finished, and
      // discovery had NOT.
      expect(manualsReleased).toBe(false);
      expect(s.client.getServerVersion()).toEqual({ name: 'hexis-mcp', version: '0.0.0' });
      // And within the budget the acceptance criteria name — measured against
      // a discovery that is, for the moment, infinitely slow.
      expect(handshakeMs).toBeLessThan(2_000);
    } finally {
      releaseManuals();
      await s.shutdown();
    }
  });

  it('makes `tools/list` wait for discovery, then answers with the discovered tools', { timeout: 60_000 }, async () => {
    holdManuals();
    const s = await start();
    try {
      await s.connect();

      let settled = false;
      const listing = s.client.listTools().finally(() => {
        settled = true;
      });
      // A list asked for while discovery is held stays pending — it does not
      // race ahead and answer "no tools", which is the failure mode this gate
      // exists to prevent.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);

      releaseManuals();
      const { tools } = await listing;
      expect(tools.map((t) => t.name)).toContain(REMOTE_TOOL);
      // The code-mode trio is served here, so the listing is the real one.
      expect(tools.map((t) => t.name)).toContain('list_tools');
      expect(tools.map((t) => t.name)).not.toContain(DISCOVERY_NOTICE_TOOL);
    } finally {
      releaseManuals();
      await s.shutdown();
    }
  });

  it('surfaces a discovery failure through the tools and on stderr, and stays up', { timeout: 60_000 }, async () => {
    manualsFailWith = 500;
    const s = await start();
    try {
      // The handshake still succeeds: the failure is downstream of it.
      await s.connect();
      await s.handle.ready;

      const { tools } = await s.client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe(DISCOVERY_NOTICE_TOOL);
      expect(tools[0]!.description).toContain('could not load this workspace');

      // The same reason on the transport a client's log pane shows.
      expect(s.stderr.some((l) => l.includes('[hexis-mcp] tool discovery failed:'))).toBe(true);

      // And a call gets the standard MCP error rather than silence.
      await expect(s.client.callTool({ name: REMOTE_TOOL, arguments: {} })).rejects.toThrow(
        /could not load this workspace/,
      );
    } finally {
      await s.shutdown();
    }
  });
});
