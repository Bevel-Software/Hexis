import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ConnectionKeyRejectedError,
  DISCOVERY_NOTICE_TOOL,
  SignInRefusedError,
  createHexisMcpServer,
  fetchAllManuals,
  type HexisMcpConfig,
} from '../index.js';

/**
 * INTEGRATION: what a client sees once the workspace refuses this process's
 * sign-in for good. The stub is a faked deployment with one remote tool, so
 * the listing before the refusal is a real one; the refusal arrives as a REST
 * 401 whose renewal the workspace refuses, as a revoke brings it.
 */

const SENTENCE =
  'The workspace refused this sign-in (revoked, or expired), so hexis-mcp has stopped renewing it: ' +
  'restart hexis-mcp to sign in through your browser again.';

let httpServer: http.Server | null = null;
let base = '';
/** The bearers the stub's REST surface refuses with 401: what a revoke on the Audit log page does. */
const refused = new Set<string>();
/** The REST reads that carried a refused bearer. */
let refusedReads = 0;

afterEach(() => {
  vi.restoreAllMocks();
  refused.clear();
  refusedReads = 0;
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
          // Both optional readers advertised, so a listing runs the catalog
          // check and reads the tool hints: the paths that would echo a refusal.
          json(200, { mcpUrl: `${base}/api/mcp`, catalogRevision: true, toolHints: true });
          return;
        }
        if (pathname.startsWith('/api/agent/')) {
          const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
          if (refused.has(bearer)) {
            refusedReads += 1;
            json(401, { error: 'Invalid token' });
            return;
          }
        }
        if (pathname === '/api/agent/catalog-revision') {
          json(200, { revision: 'rev-1' });
          return;
        }
        if (pathname === '/api/agent/tool-hints') {
          json(200, { tools: {} });
          return;
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: 'read_file', description: 'Read a file.', inputSchema: { type: 'object' } }],
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

describe('a sign-in the workspace refused for good', () => {
  it(
    'turns the listing into the hexis_unavailable notice naming the fix, tells the client, says it once on stderr, and asks nothing more',
    { timeout: 60_000 },
    async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const renew = vi.fn(async (): Promise<{ token: string }> => {
        throw new SignInRefusedError(SENTENCE);
      });
      const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'tok-0', renewConnectionKey: renew };
      // The catalog check ON, unthrottled: every listing asks the workspace.
      const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: { minIntervalMs: 0 } });
      const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
      let listChanged = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        listChanged += 1;
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const before = await client.listTools();
        expect(before.tools.map((t) => t.name)).toContain('read_file');
        expect(before.tools.map((t) => t.name)).not.toContain(DISCOVERY_NOTICE_TOOL);

        // The revoke: the bearer is refused, so the next listing's catalog
        // check meets a 401, renews, and the renewal is refused for good. That
        // very listing is already the notice, not the stale tools.
        refused.add('tok-0');
        const atRefusal = await client.listTools();
        expect(atRefusal.tools.map((t) => t.name)).toEqual([DISCOVERY_NOTICE_TOOL]);
        await vi.waitFor(() => expect(listChanged).toBe(1));
        const readsAtRefusal = refusedReads;

        const after = await client.listTools();
        expect(after.tools).toHaveLength(1);
        expect(after.tools[0]!.name).toBe(DISCOVERY_NOTICE_TOOL);
        expect(after.tools[0]!.description).toContain('restart hexis-mcp to sign in through your browser again');

        await expect(client.callTool({ name: 'read_file', arguments: {} })).rejects.toThrow(
          /restart hexis-mcp to sign in through your browser again/,
        );

        await client.listTools();
        // Nothing more is asked of the workspace once the notice stands.
        expect(refusedReads).toBe(readsAtRefusal);
        // A later REST 401 is refused without asking for a renewal.
        await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
        expect(renew).toHaveBeenCalledTimes(1);
        // Said once on stderr: no reader repeats it in its own words.
        expect(err.mock.calls.filter((c) => String(c[0]).includes(SENTENCE))).toHaveLength(1);
        expect(err.mock.calls.filter((c) => /restart hexis-mcp/.test(String(c[0])))).toHaveLength(1);
      } finally {
        await client.close();
        await handle.shutdown();
      }
    },
  );

  it('a sign-in refused during the handshake is the notice from the first listing, said once on stderr', { timeout: 60_000 }, async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renew = vi.fn(async (): Promise<{ token: string }> => {
      throw new SignInRefusedError(SENTENCE);
    });
    // Refused from the start: the handshake's catalog read is the one that meets it.
    refused.add('tok-0');
    const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'tok-0', renewConnectionKey: renew };
    const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: { minIntervalMs: 0 } });
    const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools).toHaveLength(1);
      expect(listing.tools[0]!.name).toBe(DISCOVERY_NOTICE_TOOL);
      // The sign-in notice, not the generic "could not load" discovery notice.
      expect(listing.tools[0]!.description).toContain('can no longer reach this workspace');
      expect(listing.tools[0]!.description).toContain('restart hexis-mcp to sign in through your browser again');
      expect(renew).toHaveBeenCalledTimes(1);
      expect(err.mock.calls.filter((c) => String(c[0]).includes(SENTENCE))).toHaveLength(1);
      expect(err.mock.calls.filter((c) => /discovery failed/.test(String(c[0])))).toHaveLength(0);
    } finally {
      await client.close();
      await handle.shutdown();
    }
  });

  it('an embedding host that set onSignInEnded hears the sentence once too, and has its listener back after shutdown', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const renew = vi.fn(async (): Promise<{ token: string }> => {
      throw new SignInRefusedError(SENTENCE);
    });
    const heard: string[] = [];
    const host = (sentence: string): void => {
      heard.push(sentence);
    };
    refused.add('tok-0');
    const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'tok-0', renewConnectionKey: renew, onSignInEnded: host };
    const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: { minIntervalMs: 0 } });
    const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools.map((t) => t.name)).toEqual([DISCOVERY_NOTICE_TOOL]);
      expect(heard).toEqual([SENTENCE]);
    } finally {
      await client.close();
      await handle.shutdown();
    }
    expect(config.onSignInEnded).toBe(host);
  });

  it('leaves a server started with a connection key exactly as it was: no sign-in to end', { timeout: 60_000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_key' };
    const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: false });
    try {
      await handle.ready;
      expect(config.onSignInEnded).toBeUndefined();
      // A refused key is the key's own error, not a sign-in to renew or end.
      refused.add('bevel_key');
      await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(ConnectionKeyRejectedError);
      expect(config.onSignInEnded).toBeUndefined();
    } finally {
      await handle.shutdown();
    }
  });
});
