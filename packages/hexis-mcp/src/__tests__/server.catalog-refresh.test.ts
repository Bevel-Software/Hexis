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
 * Whether the stub ADVERTISES the catalog-change stream, and every stream it
 * currently holds open. A real deployment writes the caller's fingerprint into
 * these the moment a default-branch write moves it; `commit()` below does the
 * same, which is the whole point — an IDLE connection has no activity to hang
 * a check on, so the announcement is the only thing that can reach it.
 */
let advertisesCatalogEvents = true;
const openStreams = new Set<http.ServerResponse>();
/** Every stream OPENED, with its bearer, so a reconnect and its credential are checkable. */
const streamOpens: (string | undefined)[] = [];
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
  // What a real deployment does at the same instant it drops its catalog
  // caches: tell every bridge holding a stream. Announced unconditionally,
  // including when the fingerprint did not move, because the invalidation
  // behind it carries no paths — the bridge is the one that compares.
  announce();
}

/** Write the current fingerprint into every open stream. */
function announce(): void {
  for (const stream of openStreams) {
    stream.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
  }
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
            ...(advertisesCatalogEvents ? { catalogEvents: true } : {}),
          });
        }
        if (pathname === '/api/agent/catalog-events') {
          streamOpens.push(req.headers.authorization);
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          });
          openStreams.add(res);
          res.on('close', () => openStreams.delete(res));
          // The opening revision, exactly as the route does: it is what closes
          // the gap between the bridge's startup discovery and its subscription.
          res.write(`event: revision\ndata: ${JSON.stringify({ revision })}\n\n`);
          return;
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
  streamOpens.length = 0;
  advertisesCatalogRevision = true;
  advertisesCatalogEvents = true;
  mcpUnavailable = false;
  deploymentLocal = [];
  for (const stream of openStreams) stream.end();
  openStreams.clear();
});

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A connected client, its notification log, and the teardown for both.
 *
 * Every check in these tests is one the connection's own activity asked for:
 * there is no timer, so a test that sees a check knows which listing or call
 * did the work.
 */
async function start(
  catalogCheck: false | { minIntervalMs?: number } = {},
  /**
   * OFF unless a test asks for it. Every test above this line is about the
   * activity path, and a stream running underneath would settle their changes
   * before the listing or the call they are actually measuring ever happened —
   * a green suite that had stopped testing what it names.
   */
  catalogEvents: false | { reconnectBaseMs?: number } = false,
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
    catalogCheck: catalogCheck === false ? false : { minIntervalMs: 0, ...catalogCheck },
    catalogEvents,
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
   * NO TIMER. An idle connection asks the deployment nothing: a laptop with a
   * client nobody is using must not poll its deployment every few seconds for
   * hours, and fifty of them must not do it together. The connection learns
   * of a change at its next use — a listing or a call — which is the first
   * moment a stale toolset would have cost it anything. Nothing is touched
   * here after `start` returns.
   */
  it('asks nothing while the connection is idle, and catches up at its next use', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start();
    try {
      // Discovery reads the revision once, before the manuals — that is the
      // baseline, not a check.
      const atStartup = revisionReads.length;
      expect(atStartup).toBe(1);

      commit(['ping', 'serper_search']);
      await settle(400);

      expect(revisionReads.length).toBe(atStartup);
      expect(s.notifications).toEqual([]);

      // The next use is a listing, which runs its own check and waits for it.
      expect(await listed(s.client)).toContain('serper_search');
      expect(revisionReads.length).toBe(atStartup + 1);
    } finally {
      await s.shutdown();
    }
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

/**
 * The half the activity check cannot reach: a connection nobody is using.
 *
 * A client that connects and then sits there issues no listing and makes no
 * call, so there is no moment for a check to hang off — and the acceptance
 * criterion is about a person who commits a `.tool` and waits, which is
 * exactly that connection. A timer would cover it and was taken out twice,
 * for a reason that has not changed: two seconds per idle laptop, forever,
 * for a notification nobody was waiting on. So the deployment announces
 * instead, over a stream this process subscribes to once.
 *
 * What every test here proves it does NOT do is ask: `revisionReads` must not
 * move between startup and the notification, or the "idle costs the
 * deployment nothing" property has been quietly traded away for the latency.
 */
describe('an idle connection hears about a commit', () => {
  const waitFor = async (predicate: () => boolean, what: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await settle(20);
    }
  };

  it('is told, and re-registers, with no listing and no call in between', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({}, {});
    try {
      await waitFor(() => streamOpens.length > 0, 'the catalog stream to be opened');
      // Everything the connection has done, it has now done. From here it is
      // idle: no listing, no call, nothing that a check could run behind.
      const atStartup = revisionReads.length;

      commit(['ping', 'serper_search']);

      await waitFor(() => s.notifications.includes('tools/list_changed'), 'the tool-list-changed notification');
      expect(s.notifications).toContain('prompts/list_changed');
      // The refresh happened because the deployment SAID so. Not one extra
      // digest read: nothing here polls.
      expect(revisionReads.length).toBe(atStartup);
      // And the toolset really did move, not just the notification.
      expect(await listed(s.client)).toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });

  it('subscribes with the connection key, and holds exactly one stream', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({}, {});
    try {
      await waitFor(() => streamOpens.length > 0, 'the catalog stream to be opened');
      expect(streamOpens.at(-1)).toBe('Bearer bevel_test');
      // Several changes in a row are several announcements on the SAME
      // stream — a bridge that reopened per change would be a poll with extra
      // steps.
      commit(['ping', 'a']);
      await waitFor(() => s.notifications.length > 0, 'the first notification');
      const afterFirst = s.notifications.length;
      commit(['ping', 'a', 'b']);
      await waitFor(() => s.notifications.length > afterFirst, 'the second notification');
      expect(streamOpens.length).toBe(1);
    } finally {
      await s.shutdown();
    }
  });

  it('stops asking, and stops streaming, after shutdown', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({}, { reconnectBaseMs: 20 });
    await waitFor(() => streamOpens.length > 0, 'the catalog stream to be opened');
    await s.shutdown();
    const afterShutdown = streamOpens.length;
    // A subscription left running would reconnect to a deployment this
    // process no longer serves, on a timer nobody can stop.
    await settle(300);
    expect(streamOpens.length).toBe(afterShutdown);
    expect(openStreams.size).toBe(0);
  });

  it('reconnects when the stream drops, and catches what landed while it was gone', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({}, { reconnectBaseMs: 20 });
    try {
      await waitFor(() => streamOpens.length > 0, 'the catalog stream to be opened');
      const atStartup = revisionReads.length;

      // The deployment redeploys, a proxy times the connection out, a laptop
      // sleeps: the stream ends with nobody having done anything wrong.
      for (const stream of openStreams) stream.end();
      openStreams.clear();
      // And the commit lands while nothing is connected to hear it. The
      // opening revision of the NEXT stream is what recovers it — which is
      // why the route sends one at all.
      commit(['ping', 'serper_search']);

      await waitFor(() => s.notifications.includes('tools/list_changed'), 'the notification after the reconnect');
      expect(streamOpens.length).toBeGreaterThan(1);
      // Asserted BEFORE the listing below, which is itself activity and would
      // earn a digest read of its own: what is being pinned here is that the
      // reconnect recovered the change without one.
      expect(revisionReads.length).toBe(atStartup);
      expect(await listed(s.client)).toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });

  it('ignores a keep-alive, and an announcement that changes nothing', { timeout: 60_000 }, async () => {
    commit(['ping']);
    const s = await start({}, {});
    try {
      await waitFor(() => streamOpens.length > 0, 'the catalog stream to be opened');
      for (const stream of openStreams) stream.write(':\n\n');
      // The invalidation behind a real announcement carries no paths, so an
      // ordinary note's commit announces a fingerprint that did not move. Every
      // connected bridge re-registering its whole toolset for that would be
      // the cost this design exists to avoid.
      announce();
      announce();
      await settle(300);
      expect(s.notifications).toEqual([]);
      expect(revisionReads.length).toBe(1);
    } finally {
      await s.shutdown();
    }
  });

  it('does not subscribe to a deployment that does not advertise the stream', { timeout: 60_000 }, async () => {
    advertisesCatalogEvents = false;
    commit(['ping']);
    const s = await start({}, {});
    try {
      commit(['ping', 'serper_search']);
      await settle(200);
      // Nothing was streamed, so nothing reached the idle connection…
      expect(streamOpens).toEqual([]);
      expect(s.notifications).toEqual([]);
      // …and the activity path is untouched: the next listing still carries it.
      expect(await listed(s.client)).toContain('serper_search');
    } finally {
      await s.shutdown();
    }
  });
});
