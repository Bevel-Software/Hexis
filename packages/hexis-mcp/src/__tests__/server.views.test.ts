import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_APP_MIME_TYPE } from '@bevel-software/platform-mcp-core';
import { createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * INTEGRATION: the knowledge views (views/catalog.ts) served beside the
 * deployment's own MCP App view. The faked deployment is the surface the
 * instructions test uses, plus `open_page` and the manifest that gives it a
 * `ui://hexis/page-<hash>.html` view; the knowledge base the views read is
 * faked through the catalog's `callKb`. A real MCP `Client` connects to the
 * bridge's `Server` over an in-memory transport and lists and reads, which is
 * what an MCP Apps host does.
 */

const PAGE_VIEW_URI = 'ui://hexis/page-0123abcd.html';
const PAGE_VIEW = {
  uri: PAGE_VIEW_URI,
  name: 'knowledge-base-page',
  mimeType: MCP_APP_MIME_TYPE,
  text: '<!doctype html><title>page</title>',
};
const KNOWLEDGE_VIEW = 'KnowledgeBase/Juan/Dashboards/To-Do-List.html';
const KNOWLEDGE_VIEW_URI = 'ui://hexis/views/to_do_list.html';
const KNOWLEDGE_VIEW_PAGE =
  '<!doctype html>\n<html><head><title>To-do list</title></head><body>' +
  '<script id="kb-snapshot">\nwindow.KB_SNAPSHOT = {"format":"hexis-kb-snapshot/1","nodes":{},"selection":{"type":["Task"]}};\n</script></body></html>';

let httpServer: http.Server | null = null;
let base = '';
/** Holds the deployment's MCP App manifest back, and with it the end of discovery, until released. */
let appsGate: Promise<void> = Promise.resolve();
/** When set, the deployment's MCP endpoint fails, so tool discovery does. */
let mcpBroken = false;

afterEach(() => {
  vi.restoreAllMocks();
  appsGate = Promise.resolve();
  mcpBroken = false;
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
        if (pathname === '/api/config') return json(200, { mcpUrl: `${base}/api/mcp`, agentInstructions: false });
        if (pathname === '/api/mcp') {
          if (mcpBroken) return json(500, { error: 'down' });
          const parsed = body ? (JSON.parse(body) as { method?: string }) : undefined;
          const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [{ name: 'open_page', description: 'Show a page.', inputSchema: { type: 'object', properties: {} } }],
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
        if (pathname === '/api/agent/mcp-app') {
          await appsGate;
          return json(200, { tools: { open_page: { resourceUri: PAGE_VIEW_URI } }, resources: [PAGE_VIEW] });
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

/** The knowledge base the views read: one view, found by the search and read back. */
async function fakeKb(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (tool === 'start_session') return { sessionId: 's-1' };
  if (tool === 'grep') {
    return {
      matches: [
        { path: `knowledge-base/${KNOWLEDGE_VIEW}`, text: '<title>To-do list</title>' },
        { path: `knowledge-base/${KNOWLEDGE_VIEW}`, text: '<script id="kb-snapshot">' },
      ],
    };
  }
  const path = String(args.path ?? '').replace(/^knowledge-base\//, '');
  if (tool === 'read_file' && path === KNOWLEDGE_VIEW) return { path, content: KNOWLEDGE_VIEW_PAGE };
  throw new Error(`unexpected ${tool} ${path}`);
}

/** Start the bridge and connect a real client to it; shut both down afterwards. */
async function connect(): Promise<{ client: Client; discovered: () => boolean; shutdown: () => Promise<void> }> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_e2e' };
  const handle = await createHexisMcpServer(config, '0.0.0', {
    catalogCheck: false,
    views: { callKb: fakeKb, cacheDir: null },
  });
  let settled = false;
  void handle.ready.then(
    () => (settled = true),
    () => (settled = true),
  );
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const shutdown = async (): Promise<void> => {
    await client.close().catch(() => {});
    await handle.shutdown();
  };
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, discovered: () => settled, shutdown };
  } catch (err) {
    await shutdown();
    throw err;
  }
}

const textOf = (contents: unknown[]): string => (contents[0] as { text: string }).text;

describe('knowledge views beside the deployment\'s own view', () => {
  it('lists both: each tool points at its own page, and both pages are resources', { timeout: 60_000 }, async () => {
    const { client, shutdown } = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === 'open_page')?._meta).toEqual({ ui: { resourceUri: PAGE_VIEW_URI } });
      expect(tools.find((t) => t.name === 'show_to_do_list')?._meta).toMatchObject({
        ui: { resourceUri: KNOWLEDGE_VIEW_URI },
      });
      const { resources } = await client.listResources();
      expect(resources.map((r) => r.uri)).toEqual([PAGE_VIEW_URI, KNOWLEDGE_VIEW_URI]);
    } finally {
      await shutdown();
    }
  });

  it('serves each page from its owner', { timeout: 60_000 }, async () => {
    const { client, shutdown } = await connect();
    try {
      expect(textOf((await client.readResource({ uri: PAGE_VIEW_URI })).contents)).toBe(PAGE_VIEW.text);
      const view = textOf((await client.readResource({ uri: KNOWLEDGE_VIEW_URI })).contents);
      expect(view).toContain('data-hexis-bridge');
      expect(view).toContain('id="kb-snapshot"');
    } finally {
      await shutdown();
    }
  });

  it('answers an unknown knowledge view with an error, not with the deployment\'s list', { timeout: 60_000 }, async () => {
    const { client, shutdown } = await connect();
    try {
      await expect(client.readResource({ uri: 'ui://hexis/views/nope.html' })).rejects.toThrow(/Unknown resource/);
      await expect(client.readResource({ uri: 'ui://hexis/page-ffffffff.html' })).rejects.toThrow(PAGE_VIEW_URI);
    } finally {
      await shutdown();
    }
  });

  /**
   * A host may read a view's page the moment it connects; tool discovery can
   * take as long as a cold plugin download. The knowledge view needs nothing
   * discovery builds, so it does not wait for it.
   */
  it('serves a knowledge view while discovery is still running', { timeout: 60_000 }, async () => {
    let release!: () => void;
    appsGate = new Promise<void>((resolve) => (release = resolve));
    const { client, discovered, shutdown } = await connect();
    try {
      const view = textOf((await client.readResource({ uri: KNOWLEDGE_VIEW_URI })).contents);
      expect(view).toContain('data-hexis-bridge');
      expect(discovered()).toBe(false);
    } finally {
      release();
      await shutdown();
    }
  });

  /**
   * The views read through the deployment's KB tools, not through the tools
   * discovery loads, so a failed discovery is no reason to lose them.
   */
  it('keeps the knowledge views listed and callable when the workspace tools could not be loaded', { timeout: 60_000 }, async () => {
    mcpBroken = true;
    const { client, shutdown } = await connect();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('show_to_do_list');
      expect(names).not.toContain('open_page');
      const result = await client.callTool({ name: 'show_to_do_list', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect((result.content as { text: string }[])[0]?.text).toContain('To-do list');
    } finally {
      await shutdown();
    }
  });
});
