import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHexisMcpServer } from '../server.js';
import { fetchToolHints } from '../deployment.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: the read-only hint as `hexis-mcp` lists it.
 *
 * This process discovers the deployment's tools through the deployment's MCP
 * endpoint, and the UTCP MCP protocol keeps no annotation on the way in — so
 * the hints come from `GET /api/agent/tool-hints`, read on every listing. The
 * stub below is a genuine stateless MCP endpoint plus that route, whose map
 * the test moves the way an admin's toggle would.
 */

let httpServer: http.Server | null = null;
let base = '';
/** What the deployment's hint route answers; null makes it answer 404, as an older deployment does. */
let hints: Record<string, boolean> | null = null;
/** Make the hint route fail transiently (a redeploy). */
let hintsUnavailable = false;
/** Whether `/api/config` advertises the hint route; an older deployment does not. */
let advertiseHints = true;
/** Make the hint route answer 401, as an older deployment answers any unknown `/api/agent/…` path. */
let hintsUnauthorized = false;
/** How many times the hint route was asked. */
let hintReads = 0;
/** A local-only `.tool` the deployment hands over, served here with one tool. */
let localTools: string[] = [];

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
          return json(200, { mcpUrl: `${base}/api/mcp`, ...(advertiseHints ? { toolHints: true } : {}) });
        }
        if (pathname === '/api/agent/all-tools') {
          return json(200, {
            manuals: localTools.map((name) => ({
              name,
              call_template_type: 'http',
              http_method: 'GET',
              url: `${base}/api/tools/${name}/manual`,
            })),
          });
        }
        if (pathname === '/api/agent/tools/list_local_tools') {
          return json(200, { tools: localTools.map((name) => ({ name, slug: name, path: `Plugins/Everyone/${name}.tool` })) });
        }
        const manual = /^\/api\/tools\/([^/]+)\/manual$/.exec(pathname);
        if (manual) {
          return json(200, {
            utcp_version: '1.1.0',
            manual_version: '1.0.0',
            tools: [
              {
                name: 'ping',
                description: `the ${manual[1]} local tool`,
                inputs: { type: 'object', properties: {} },
                outputs: { type: 'object', properties: {} },
                // Its author's tag is not the platform's word: it stays unannotated.
                tags: ['read-only'],
                tool_call_template: { call_template_type: 'http', http_method: 'POST', url: `${base}/api/never`, content_type: 'application/json' },
              },
            ],
          });
        }
        if (pathname === '/api/agent/tool-hints') {
          hintReads += 1;
          if (hintsUnauthorized) return json(401, { error: 'unauthorized' });
          if (hintsUnavailable) return json(503, { error: 'restarting' });
          return hints ? json(200, { tools: hints }) : json(404, {});
        }
        if (pathname === '/api/mcp') {
          const parsed = body ? (JSON.parse(body) as unknown) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: ['read_file', 'write_file', 'list_tools', 'tools_info', 'call_tool_chain'].map((name) => ({
              name,
              description: `the ${name} tool`,
              inputSchema: { type: 'object' as const, properties: {} },
            })),
          }));
          mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
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
  hints = null;
  hintsUnavailable = false;
  advertiseHints = true;
  hintsUnauthorized = false;
  hintReads = 0;
  localTools = [];
});

async function start(
  extra: Partial<HexisMcpConfig> = {},
): Promise<{ client: Client; shutdown: () => Promise<void> }> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_test', ...extra };
  const handle = await createHexisMcpServer(config, '0.0.0', { catalogCheck: false });
  await handle.ready;
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    shutdown: async () => {
      await client.close().catch(() => {});
      await handle.shutdown();
    },
  };
}

const annotationsOf = async (client: Client) =>
  Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.annotations]));

const BUILT_IN = { read_file: true, write_file: false, list_tools: true, tools_info: true, call_tool_chain: false };

describe('hexis-mcp lists the read-only hint the deployment serves', () => {
  it('on every platform tool and every meta-tool, and no other annotation', async () => {
    hints = { ...BUILT_IN };
    const { client, shutdown } = await start();
    try {
      expect(await annotationsOf(client)).toEqual({
        list_tools: { readOnlyHint: true },
        tools_info: { readOnlyHint: true },
        call_tool_chain: { readOnlyHint: false },
        read_file: { readOnlyHint: true },
        write_file: { readOnlyHint: false },
      });
    } finally {
      await shutdown();
    }
  });

  it("lists an admin's change on the NEXT tools/list, with no restart or reconnect", async () => {
    hints = { ...BUILT_IN };
    const { client, shutdown } = await start();
    try {
      expect((await annotationsOf(client)).write_file).toEqual({ readOnlyHint: false });
      hints = { ...BUILT_IN, write_file: true, read_file: false, call_tool_chain: true };
      const listed = await annotationsOf(client);
      expect(listed.write_file).toEqual({ readOnlyHint: true });
      expect(listed.read_file).toEqual({ readOnlyHint: false });
      expect(listed.call_tool_chain).toEqual({ readOnlyHint: true });
    } finally {
      await shutdown();
    }
  });

  it('keeps the hints it had through a transient failure of the route', async () => {
    hints = { ...BUILT_IN, read_file: false };
    const { client, shutdown } = await start();
    try {
      expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: false });
      hintsUnavailable = true;
      expect((await annotationsOf(client)).read_file).toEqual({ readOnlyHint: false });
    } finally {
      await shutdown();
    }
  });

  it('lists a deployment without the route as before: platform tools unannotated, meta-tools on their built-in hint', async () => {
    hints = null;
    advertiseHints = false;
    const { client, shutdown } = await start();
    try {
      const listed = await annotationsOf(client);
      expect(listed.read_file).toBeUndefined();
      expect(listed.write_file).toBeUndefined();
      expect(listed.call_tool_chain).toEqual({ readOnlyHint: false });
      expect(listed.list_tools).toEqual({ readOnlyHint: true });
    } finally {
      await shutdown();
    }
  });

  /**
   * An older deployment answers the unknown route with 401, and an OAuth
   * config reads a 401 as an expired token: asking anyway would refresh the
   * sign-in on every listing. So the route is asked only when advertised.
   */
  it('never asks a deployment that does not advertise the route, so its 401 cannot renew an OAuth sign-in', async () => {
    advertiseHints = false;
    hintsUnauthorized = true;
    const renewConnectionKey = vi.fn(async () => ({ token: 'bevel_fresh' }));
    const { client, shutdown } = await start({ renewConnectionKey });
    try {
      await annotationsOf(client);
      await annotationsOf(client);
      expect(hintReads).toBe(0);
      expect(renewConnectionKey).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it('an older read that finishes last never reverts the newer hints it kept', async () => {
    hints = { ...BUILT_IN };
    const { client, shutdown } = await start();
    try {
      expect((await annotationsOf(client)).write_file).toEqual({ readOnlyHint: false });
      // Two overlapping listings: the first read is held back until the
      // second (which already sees the admin's change) has answered.
      const realFetch = globalThis.fetch;
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
      let held = false;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).endsWith('/api/agent/tool-hints') && !held) {
          held = true;
          const answer = await realFetch(input, init);
          await firstHeld;
          return answer;
        }
        return realFetch(input, init);
      });
      const older = annotationsOf(client);
      await vi.waitFor(() => expect(held).toBe(true));
      hints = { ...BUILT_IN, write_file: true };
      expect((await annotationsOf(client)).write_file).toEqual({ readOnlyHint: true });
      releaseFirst();
      expect((await older).write_file).toEqual({ readOnlyHint: false });
      // The route now fails: the hints kept are the newer read's, not the older one's.
      hintsUnavailable = true;
      expect((await annotationsOf(client)).write_file).toEqual({ readOnlyHint: true });
    } finally {
      await shutdown();
    }
  });

  it('leaves a local `.tool` unannotated, whatever its manual tags it', async () => {
    hints = { ...BUILT_IN, localbox_ping: true };
    localTools = ['localbox'];
    const { client, shutdown } = await start();
    try {
      const tools = (await client.listTools()).tools;
      const local = tools.find((t) => t.name === 'localbox_ping');
      expect(local).toBeDefined();
      expect(local).not.toHaveProperty('annotations');
    } finally {
      await shutdown();
    }
  });
});

describe('fetchToolHints', () => {
  const config: HexisMcpConfig = { baseUrl: '', connectionKey: 'bevel_test' };

  it('reads the map with the connection key, keeping only boolean values', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hints = { read_file: true, write_file: 'false', grep: 1, list_files: null } as unknown as Record<string, boolean>;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchToolHints({ ...config, baseUrl: base })).toEqual({ read_file: true });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe(`${base}/api/agent/tool-hints`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer bevel_test');
  });

  it('answers no hints for a deployment without the route, and the previous ones on a transient failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    hints = null;
    expect(await fetchToolHints({ ...config, baseUrl: base }, { read_file: false })).toEqual({});
    hintsUnavailable = true;
    expect(await fetchToolHints({ ...config, baseUrl: base }, { read_file: false })).toEqual({ read_file: false });
  });

  it('says a failure once per deployment: one deployment never silences or re-arms another', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    hints = null;
    const other = base.replace('127.0.0.1', 'localhost');
    // A success on each first, so what earlier tests logged does not count here.
    hints = { read_file: true };
    await fetchToolHints({ ...config, baseUrl: base });
    await fetchToolHints({ ...config, baseUrl: other });
    hints = null;
    await fetchToolHints({ ...config, baseUrl: base });
    await fetchToolHints({ ...config, baseUrl: base });
    expect(logged).toHaveBeenCalledTimes(1);
    await fetchToolHints({ ...config, baseUrl: other });
    expect(logged).toHaveBeenCalledTimes(2);
    hints = { read_file: true };
    await fetchToolHints({ ...config, baseUrl: other });
    hints = null;
    await fetchToolHints({ ...config, baseUrl: base });
    expect(logged).toHaveBeenCalledTimes(2);
  });
});
