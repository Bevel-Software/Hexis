import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHexisMcpServer } from '../server.js';
import { renewConnectionKeyNow } from '../renewal.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: the OAuth credential swap at the two edges renewal.test.ts
 * cannot reach — around the remote manual's REGISTRATION, and around
 * SHUTDOWN. The stub is the same faked deployment surface the teardown e2e
 * uses (a genuine stateless streamable-HTTP MCP endpoint, so registration is
 * real), and every /api/mcp POST records its bearer: which credential a
 * registration actually presented is the whole question here.
 *
 * Pinned regressions: a renewal completing while registration is in flight
 * used to be lost — the swap listener did not exist yet, and the manual rode
 * the retired bearer until the next renewal; and a renewal racing shutdown
 * used to swap against the already-closing UTCP client.
 */

interface McpPost {
  method: string;
  authorization: string | undefined;
}

let httpServer: http.Server | null = null;
let base = '';
const mcpPosts: McpPost[] = [];
/** Armed by the test: holds the FIRST initialize's response until it resolves. */
let onFirstInitialize: (() => Promise<void>) | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  // Module-level stub state must not leak between tests: a leftover recording
  // (or an unconsumed initialize gate) would skew whatever runs next.
  mcpPosts.length = 0;
  onFirstInitialize = null;
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
          json(200, { mcpUrl: `${base}/api/mcp` });
          return;
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as { method?: string }) : undefined;
          if (req.method === 'POST') {
            mcpPosts.push({ method: String(parsed?.method ?? ''), authorization: req.headers.authorization });
            // The gate: the first initialize IS the remote manual's
            // registration, so whatever the armed callback runs to completion
            // here has deterministically landed while it was in flight.
            if (parsed?.method === 'initialize' && onFirstInitialize) {
              const gate = onFirstInitialize;
              onFirstInitialize = null;
              await gate();
            }
          }
          // Stateless streamable-HTTP, one server + transport per request —
          // the SDK's documented sessionless shape, same as the teardown e2e.
          const mcp = new Server(
            { name: 'stub-deployment', version: '0.0.0' },
            { capabilities: { tools: {} } },
          );
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
        if (pathname === '/api/agent/all-tools') {
          json(200, { manuals: [] });
          return;
        }
        if (pathname === '/api/agent/tools/list_local_tools') {
          json(200, { tools: [] });
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

describe('credential swap around registration and shutdown', () => {
  it(
    'applies a renewal that lands while the remote manual is registering — and none after shutdown',
    { timeout: 60_000 },
    async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      let minted = 0;
      const config: HexisMcpConfig = {
        baseUrl: base,
        connectionKey: 'tok-0',
        // No expiresInMs: reactive-only, so no timers outlive this test.
        renewConnectionKey: async () => ({ token: `tok-${(minted += 1)}` }),
      };
      let renewed: Promise<string> | null = null;
      onFirstInitialize = (): Promise<void> => {
        renewed = renewConnectionKeyNow(config);
        return renewed.then(() => undefined);
      };

      const handle = await createHexisMcpServer(config, '0.0.0');
      try {
        expect(await renewed!).toBe('tok-1');
        const inits = mcpPosts.filter((p) => p.method === 'initialize');
        // Registration started on the token it read at registration time…
        expect(inits[0]?.authorization).toBe('Bearer tok-0');
        // …and the renewal that completed mid-registration was reconciled:
        // the manual ends up re-registered with the fresh bearer, not riding
        // the retired one until the next renewal.
        expect(inits.length).toBeGreaterThanOrEqual(2);
        expect(inits.at(-1)?.authorization).toBe('Bearer tok-1');
        expect(err).toHaveBeenCalledWith(expect.stringContaining('re-registered'));
      } finally {
        await handle.shutdown();
      }

      // A straggler renewal STARTING after teardown (a REST read's 401 path
      // racing shutdown) is refused outright: no new grant is minted, and no
      // swap runs against the closed client.
      const initsAfterShutdown = mcpPosts.filter((p) => p.method === 'initialize').length;
      await expect(renewConnectionKeyNow(config)).rejects.toThrow(/shut down/);
      expect(minted).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(mcpPosts.filter((p) => p.method === 'initialize').length).toBe(initsAfterShutdown);
    },
  );
});
