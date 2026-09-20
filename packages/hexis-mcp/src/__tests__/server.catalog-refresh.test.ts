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
 * ALREADY CONNECTED here — no reconnect, no restart — and it reaches it when
 * that client next uses the connection, never on a timer.
 *
 * This is the half of the acceptance criteria the hosted endpoint gets for
 * free and this process does not. Hosted is stateless: every request rebuilds
 * its surface from the live registry. This process registered the deployment's
 * manuals once, at startup, and the sessions those registrations created are
 * what its `tools/list` is built from — so without the check, a `.tool`
 * committed a minute ago is invisible here until someone restarts it. That was
 * the reported bug.
 *
 * The stub is a genuine stateless streamable-HTTP MCP endpoint (so
 * registration and re-registration are real), whose tool list, local-only
 * manuals and catalog revision the test moves the way a commit would.
 */

let httpServer: http.Server | null = null;
let base = '';
/** The deployment's remote tool list, as a commit would change it. */
let deploymentTools: string[] = [];
/**
 * The deployment's LOCAL-ONLY `.tool` manuals, by name — each served as the
 * platform reference a real deployment hands over (`/api/tools/<slug>/manual`),
 * whose manual the stub answers with one tool.
 */
let deploymentLocal: string[] = [];
/**
 * Whether the stub deployment ADVERTISES the catalog-revision route. A
 * deployment older than this package does not, and must not be probed for it:
 * an unknown `/api/*` path falls through to its JWT mounts and answers 401,
 * which a checker would report as a dead connection key.
 */
let advertisesCatalogRevision = true;
/**
 * Whether the deployment's MCP endpoint is refusing — a redeploy, a proxy
 * blip. The catalog route keeps answering, so the check sees the change and
 * the re-registration that follows it is what fails.
 */
let mcpUnavailable = false;
/** Its catalog fingerprint. Moves when — and only when — the lists above do. */
let revision = 'rev-1';
/** Every catalog-revision read's bearer, so the check's credential is checkable. */
const revisionReads: (string | undefined)[] = [];

/** Change what the deployment serves, exactly as a default-branch commit would. */
function commit(tools: string[], local: string[] = deploymentLocal): void {
  deploymentTools = tools;
  deploymentLocal = local;
  revision = `rev-${tools.join('+')}|${local.join('+')}`;
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
        if (pathname === '/api/agent/all-tools') {
          // Read at request time: a refresh after a commit must see the new
          // list, exactly as it would against a real deployment.
          return json(200, {
            manuals: deploymentLocal.map((name) => ({
              name,
              call_template_type: 'http',
              http_method: 'GET',
              url: `${base}/api/tools/${name}/manual`,
            })),
          });
        }
        if (pathname === '/api/agent/tools/list_local_tools') {
          return json(200, {
            tools: deploymentLocal.map((name) => ({ name, slug: name, path: `Plugins/Everyone/${name}.tool` })),
          });
        }
        const manual = /^\/api\/tools\/([^/]+)\/manual$/.exec(pathname);
        if (manual) {
          const name = manual[1]!;
          return json(200, {
            utcp_version: '1.1.0',
            manual_version: '1.0.0',
            tools: [
              {
                name: 'ping',
                description: `the ${name} local tool`,
                inputs: { type: 'object', properties: {} },
                outputs: { type: 'object', properties: {} },
                tags: [],
                tool_call_template: {
                  call_template_type: 'http',
                  http_method: 'POST',
                  url: `${base}/api/never-dialed`,
                  content_type: 'application/json',
                },
              },
            ],
          });
        }
        if (pathname === '/api/agent/catalog-revision') {
          revisionReads.push(req.headers.authorization);
          return json(200, { revision, tools: deploymentTools.length, skills: 0 });
        }
        if (pathname === '/api/mcp') {
          if (mcpUnavailable) return json(503, { error: 'the deployment is restarting' });
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
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
  revisionReads.length = 0;
  advertisesCatalogRevision = true;
  mcpUnavailable = false;
  deploymentLocal = [];
});

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `condition` holds, or fail naming what was being waited for. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(20);
  }
}

/**
 * A connected client, its notification log, and the teardown for both.
 *
 * The heartbeat is OFF by default here, so each test below says which trigger
 * it is about: most of them are about the activity check, and a timer firing
 * underneath them would make it impossible to tell which one did the work.
 * The heartbeat has its own tests, which turn it on.
 */
async function start(
  catalogCheck: false | { minIntervalMs?: number; heartbeatMs?: number } = {},
): Promise<{
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
  const handle = await createHexisMcpServer(config, '0.0.0', {
    catalogCheck: catalogCheck === false ? false : { minIntervalMs: 0, heartbeatMs: 0, ...catalogCheck },
  });
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
  it('re-registers the catalog and sends tool-list-changed, on the same connection, when next listed', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      expect(await listed(s.client)).toContain('ping');
      expect(await listed(s.client)).not.toContain('serper_search');

      // The commit: a `.tool` is added to the default branch.
      commit(['ping', 'serper_search']);

      // The client's next listing is what notices it: the check runs on that
      // listing and the answer already holds the new tool — no reconnect, no
      // restart, same client object throughout.
      const after = await listed(s.client);
      expect(after).toContain('serper_search');
      expect(after).toContain('ping');
      // The capability is DECLARED, which is what permits the notification at
      // all — a client reads it to decide whether it may trust the list it
      // holds between notifications.
      expect(s.client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
      // Both notifications went out with the refresh, before the list answered.
      expect(s.notifications).toContain('tools/list_changed');
      expect(s.notifications).toContain('prompts/list_changed');
    } finally {
      await s.shutdown();
    }
  });

  it('notices the change when a tool CALL finishes, and tells the client', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      expect(await listed(s.client)).toContain('ping');
      commit(['ping', 'serper_search']);

      // No listing: a call. The check runs once the call has answered, and
      // the client learns of the change through the notification.
      const result = await s.client.callTool({ name: 'ping', arguments: {} });
      expect(result.isError).not.toBe(true);
      const deadline = Date.now() + 20_000;
      while (!s.notifications.includes('tools/list_changed')) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the tool-list-changed notification');
        await settle(20);
      }
      expect(await listed(s.client)).toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });

  it('drops a removed manual from the same connection', { timeout: 60_000 }, async () => {
    commit(['ping', 'retired_tool']);
    const s = await start();
    try {
      expect(await listed(s.client)).toContain('retired_tool');

      commit(['ping']);
      expect(await listed(s.client)).not.toContain('retired_tool');
      expect(await listed(s.client)).toContain('ping');
      expect(s.notifications).toContain('tools/list_changed');
    } finally {
      await s.shutdown();
    }
  });

  /**
   * The local-only half — the manuals this process exists to add. A local
   * `.tool` committed on the deployment is registered HERE, on the same
   * connection, by the same refresh: nothing about it needs a restart.
   */
  it('registers a LOCAL-only manual added on the deployment, and drops one removed', { timeout: 60_000 }, async () => {
    commit(['ping'], []);
    const s = await start();
    try {
      expect(await listed(s.client)).not.toContain('localbox_ping');

      // The commit: a `local: true` .tool lands on the default branch.
      commit(['ping'], ['localbox']);
      const after = await listed(s.client);
      // Namespaced, as every local manual's tools are (`localbox.ping` →
      // `localbox_ping`), beside the deployment's own bare `ping`.
      expect(after).toContain('localbox_ping');
      expect(after).toContain('ping');
      expect(s.stderr.some((line) => line.includes('1 local-only manual(s) registered here'))).toBe(true);

      // And gone again when the commit that removes it lands.
      commit(['ping'], []);
      const gone = await listed(s.client);
      expect(gone).not.toContain('localbox_ping');
      expect(gone).toContain('ping');
    } finally {
      await s.shutdown();
    }
  });

  /**
   * A re-registration that FAILS must not cost the connection its toolset for
   * good. The refresh deregisters first, so a registration that then fails
   * leaves the manual absent — and the retry that follows has to get past its
   * own cleanup step to put it back. (An already-absent manual is `false` from
   * the client's `deregisterManual`, not an error; a cleanup step that took
   * "nothing to remove" for "could not remove" would loop here forever and the
   * connection would never see another tool.)
   *
   * Nothing is committed between the failure and the recovery: the change is
   * still OWED, and the checker is what remembers that.
   */
  it('restores the toolset by retrying a re-registration that failed', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      expect(await listed(s.client)).toContain('ping');

      // The deployment goes away, and the commit lands while it is away: the
      // check sees the new revision, deregisters, and cannot register again.
      mcpUnavailable = true;
      commit(['ping', 'serper_search']);
      await listed(s.client);
      expect(s.stderr.some((line) => line.includes('refreshing the toolset after a workspace change failed'))).toBe(true);
      expect(s.notifications).toEqual([]); // nothing to tell a client yet

      // It comes back. No new commit — the owed change is delivered by the
      // next check, which the next listing runs.
      mcpUnavailable = false;
      const after = await listed(s.client);
      expect(after).toContain('serper_search');
      expect(after).toContain('ping');
      expect(s.notifications).toContain('tools/list_changed');
      // One line for the streak, not one per attempt.
      expect(
        s.stderr.filter((line) => line.includes('refreshing the toolset after a workspace change failed')),
      ).toHaveLength(1);
    } finally {
      await s.shutdown();
    }
  });

  /**
   * THE HEARTBEAT, and why it exists.
   *
   * Staging failed this ticket on exactly this case: an idle connection got
   * zero notifications in eight seconds after a commit. A check driven only by
   * activity cannot serve a notification, because the notification exists for
   * the client that is NOT asking — an editor sitting open is the normal state
   * of a connection, and it generates nothing to hang a check on.
   *
   * So the connection also checks on a timer. Nothing is touched here after
   * `start` returns: no listing, no call.
   */
  it('tells an IDLE connection, with no listing or call to prompt it', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({ heartbeatMs: 50 });
    try {
      commit(['ping', 'serper_search']);

      await waitFor(
        () => s.notifications.includes('tools/list_changed'),
        'the tool-list-changed notification on an idle connection',
      );
      // The client did nothing to earn it: the notification is the FIRST
      // thing that happened on this connection since it was opened.
      expect(await listed(s.client)).toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });

  /**
   * And the heartbeat is what does it — the same commit, the same idle
   * connection, with only the timer turned off.
   */
  it('stays silent on an idle connection when the heartbeat is off', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({ heartbeatMs: 0 });
    try {
      // Discovery reads the revision once, before the manuals — that is the
      // baseline, not a check.
      const atStartup = revisionReads.length;
      expect(atStartup).toBe(1);

      commit(['ping', 'serper_search']);
      await settle(400);

      expect(revisionReads.length).toBe(atStartup);
      expect(s.notifications).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  /**
   * A heartbeat longer than Node's timers can hold must not become a hot loop.
   * `setInterval` does not clamp a delay above 2^31-1 ms — it wraps, and fires
   * after ONE millisecond — so an embedding host asking to check "about once a
   * month" would hammer its deployment with digest reads forever.
   */
  it('does not hammer the deployment when asked for an enormous heartbeat', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({ heartbeatMs: 30 * 24 * 60 * 60 * 1_000 }); // 30 days
    try {
      const atStartup = revisionReads.length;
      await settle(400);
      // A wrapped timer would have run hundreds of checks by now.
      expect(revisionReads.length).toBe(atStartup);
    } finally {
      await s.shutdown();
    }
  });

  /** A heartbeat must not outlive the server it belongs to. */
  it('stops its heartbeat at shutdown', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({ heartbeatMs: 30 });
    await waitFor(() => revisionReads.length > 2, 'a few heartbeat checks');

    await s.shutdown();
    const afterShutdown = revisionReads.length;
    await settle(300);
    expect(revisionReads.length).toBe(afterShutdown);
  });

  it('stays quiet while the catalog does not move, however often it is used', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      for (let i = 0; i < 6; i += 1) expect(await listed(s.client)).toContain('ping');
      // Used, so checked — and nothing moved, so no session was re-made and
      // no client was told anything.
      expect(revisionReads.length).toBeGreaterThan(1);
      expect(s.notifications).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });

  /**
   * The throttle, end to end: a burst of activity is one read, not one per
   * event.
   */
  it('reads the revision at most once per interval however busy the connection is', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({ minIntervalMs: 60_000 });
    try {
      const atStartup = revisionReads.length;
      for (let i = 0; i < 5; i += 1) await listed(s.client);
      for (let i = 0; i < 5; i += 1) await s.client.callTool({ name: 'ping', arguments: {} });
      await settle(100);
      expect(revisionReads.length).toBe(atStartup + 1);
    } finally {
      await s.shutdown();
    }
  });

  it('checks with the connection key, and checks nothing after shutdown', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      await listed(s.client);
      expect(revisionReads.at(-1)).toBe('Bearer bevel_test');
    } finally {
      await s.shutdown();
    }
    const afterShutdown = revisionReads.length;
    await settle(200);
    expect(revisionReads.length).toBe(afterShutdown);
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
    const s = await start();
    try {
      commit(['ping', 'serper_search']);
      // The toolset stays what discovery found — and the reader is told why,
      // rather than being left to wonder why a tool they added never showed up.
      expect(await listed(s.client)).not.toContain('serper_search');
      expect(revisionReads).toEqual([]);
      expect(s.notifications).toEqual([]);
      expect(s.stderr.some((line) => line.includes('predates catalog change detection'))).toBe(true);
    } finally {
      await s.shutdown();
    }
  });

  /**
   * The check is opt-out, so an embedding host that wants the old frozen-at-
   * startup behaviour can have it — and so this suite can prove the refresh is
   * what makes the difference, rather than something else in the process.
   */
  it('leaves the toolset frozen when the check is turned off', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start(false);
    // Discovery still reads the revision once, before the manuals — that is
    // the baseline, not a check. What the off switch stops is everything after.
    const atStartup = revisionReads.length;
    try {
      commit(['ping', 'serper_search']);
      expect(await listed(s.client)).not.toContain('serper_search');
      expect(revisionReads.length).toBe(atStartup);
      expect(s.notifications).toEqual([]);
    } finally {
      await s.shutdown();
    }
  });
});
