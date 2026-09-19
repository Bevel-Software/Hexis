import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: a tool manual added to the deployment reaches a client that is
 * ALREADY CONNECTED here — no reconnect, no restart.
 *
 * This is the half of the acceptance criteria the hosted endpoint gets for
 * free and this process does not. Hosted is stateless: every request rebuilds
 * its surface from the live registry. This process registered the deployment's
 * manual once, at startup, and the MCP session that registration created is
 * what its `tools/list` is built from — so without the watch, a `.tool`
 * committed a minute ago is invisible here until someone restarts it. That was
 * the reported bug.
 *
 * The stub is a genuine stateless streamable-HTTP MCP endpoint (so
 * registration and re-registration are real), whose tool list and catalog
 * revision the test moves the way a commit would.
 */

let httpServer: http.Server | null = null;
let base = '';
/** The deployment's tool list, as a commit would change it. */
let deploymentTools: string[] = [];
/**
 * Whether the stub deployment ADVERTISES the catalog-revision route. A
 * deployment older than this package does not, and must not be probed for it:
 * an unknown `/api/*` path falls through to its JWT mounts and answers 401,
 * which a poller would report as a dead connection key.
 */
let advertisesCatalogRevision = true;
/** Its catalog fingerprint. Moves when — and only when — the list above does. */
let revision = 'rev-1';
/** Every catalog-revision poll's bearer, so the poll's credential is checkable. */
const revisionPolls: (string | undefined)[] = [];

/** Change what the deployment serves, exactly as a default-branch commit would. */
function commit(tools: string[]): void {
  deploymentTools = tools;
  revision = `rev-${tools.join('+')}`;
}

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
          return json(200, {
            mcpUrl: `${base}/api/mcp`,
            ...(advertisesCatalogRevision ? { catalogRevision: true } : {}),
          });
        }
        if (pathname === '/api/agent/all-tools') return json(200, { manuals: [] });
        if (pathname === '/api/agent/tools/list_local_tools') return json(200, { tools: [] });
        if (pathname === '/api/agent/catalog-revision') {
          revisionPolls.push(req.headers.authorization);
          return json(200, { revision, tools: deploymentTools.length, skills: 0 });
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
          // Read at request time: a re-registration after a commit must see
          // the new list, exactly as it would against a real deployment.
          const served = [...deploymentTools];
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: served.map((name) => ({
              name,
              description: `the ${name} tool`,
              inputSchema: { type: 'object' as const, properties: {} },
            })),
          }));
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({
            content: [{ type: 'text' as const, text: 'ok' }],
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

afterEach(() => {
  vi.restoreAllMocks();
  revisionPolls.length = 0;
  advertisesCatalogRevision = true;
});

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A connected client, its notification log, and the teardown for both. */
async function start(catalogPollMs: number): Promise<{
  client: Client;
  notifications: string[];
  stderr: string[];
  shutdown: () => Promise<void>;
}> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_test' };
  const handle = await createHexisMcpServer(config, '0.0.0', { catalogPollMs });
  await handle.ready;

  const notifications: string[] = [];
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notifications.push('tools/list_changed');
  });
  client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
    notifications.push('prompts/list_changed');
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    notifications,
    stderr,
    shutdown: async () => {
      await client.close().catch(() => {});
      await handle.shutdown();
    },
  };
}

const listed = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((t) => t.name);

describe('a manual added on the deployment reaches an already-connected client', () => {
  it('re-registers the catalog and sends tool-list-changed, on the same connection', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start(50);
    try {
      expect(await listed(s.client)).toContain('ping');
      expect(await listed(s.client)).not.toContain('serper_search');

      // The commit: a `.tool` is added to the default branch.
      commit(['ping', 'serper_search']);

      await waitFor(() => s.notifications.includes('tools/list_changed'), 'the tool-list-changed notification');
      // The capability is DECLARED, which is what permits the notification at
      // all — a client reads it to decide whether it may trust the list it
      // holds between notifications.
      expect(s.client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
      expect(s.notifications).toContain('prompts/list_changed');

      // And the list the connection actually answers with now holds it — no
      // reconnect, no restart, same client object throughout.
      const after = await listed(s.client);
      expect(after).toContain('serper_search');
      expect(after).toContain('ping');
    } finally {
      await s.shutdown();
    }
  });

  it('drops a removed manual from the same connection', { timeout: 60_000 }, async () => {
    commit(['ping', 'retired_tool']);
    const s = await start(50);
    try {
      expect(await listed(s.client)).toContain('retired_tool');

      commit(['ping']);
      await waitFor(() => s.notifications.includes('tools/list_changed'), 'the tool-list-changed notification');

      expect(await listed(s.client)).not.toContain('retired_tool');
      expect(await listed(s.client)).toContain('ping');
    } finally {
      await s.shutdown();
    }
  });

  it('stays quiet while the catalog does not move', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start(20);
    try {
      // Long enough for many polls: the watch must not re-register an MCP
      // session — closing whatever it held — for a deployment nobody edited.
      await waitFor(() => revisionPolls.length > 10, 'several catalog polls');
      expect(s.notifications).toEqual([]);
      expect(await listed(s.client)).toContain('ping');
    } finally {
      await s.shutdown();
    }
  });

  it('polls with the connection key, and stops polling at shutdown', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start(20);
    await waitFor(() => revisionPolls.length > 0, 'a catalog poll');
    expect(revisionPolls[0]).toBe('Bearer bevel_test');

    await s.shutdown();
    const afterShutdown = revisionPolls.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(revisionPolls.length).toBe(afterShutdown);
  });

  /**
   * A deployment older than this package does not serve the route, and must
   * NEVER be asked for it: an unknown `/api/*` path falls through to its JWT
   * mounts and answers 401, and this process reads a 401 as a rejected
   * credential — so a probe would tell the user to mint a new connection key
   * because of a route that simply is not there. Hence the capability flag on
   * `/api/config`, the same mechanism agent instructions use.
   */
  it('never probes a deployment that does not advertise the route', { timeout: 60_000 }, async () => {
    advertisesCatalogRevision = false;
    commit(['ping']);
    const s = await start(20);
    try {
      commit(['ping', 'serper_search']);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(revisionPolls).toEqual([]);
      expect(s.notifications).toEqual([]);
      // The toolset stays what discovery found — and the reader is told why,
      // rather than being left to wonder why a tool they added never showed up.
      expect(await listed(s.client)).not.toContain('serper_search');
      expect(s.stderr.some((line) => line.includes('predates catalog change detection'))).toBe(true);
    } finally {
      await s.shutdown();
    }
  });

  /**
   * The watch is opt-out, so an embedding host that wants the old frozen-at-
   * startup behaviour can have it — and so this suite can prove the refresh is
   * what makes the difference, rather than something else in the process.
   */
  it('leaves the toolset frozen when the watch is turned off', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start(0);
    // Discovery still reads the revision once, alongside the manuals — that is
    // the baseline, not a poll. What the off switch stops is everything after.
    const atStartup = revisionPolls.length;
    try {
      commit(['ping', 'serper_search']);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(revisionPolls.length).toBe(atStartup);
      expect(s.notifications).toEqual([]);
      expect(await listed(s.client)).not.toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });
});
