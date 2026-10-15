import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Window } from 'happy-dom';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { createHexisMcpServer } from '../server.js';
import type { HexisMcpConfig } from '../config.js';
import { fakeKb, page, snapshotOnPage } from './fixtures/views-kb.js';

/**
 * END TO END, through the real intermediary: a knowledge view rendered by a
 * real MCP Apps host. The host is the ext-apps `AppBridge` (the host side of
 * the MCP Apps protocol that hosts build on), its tool calls go to a real MCP
 * client connected to the real hexis-mcp server, and the server reads a
 * faked knowledge base. The view is the page the server serves, run in a DOM
 * of its own (happy-dom), with the bridge, the compact presentation and the
 * app's navigation runtime exactly as served.
 *
 * What this pins that a hand-written host cannot: that the view's messages
 * are ones a real host accepts and answers, in both directions, and that a
 * tool result, a link and a change each make the whole trip.
 */

let httpServer: http.Server | null = null;
let base = '';

beforeAll(async () => {
  // The deployment, as far as discovery needs one: no tools, no app of its own.
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
        if (pathname === '/api/agent/mcp-app') return json(200, { tools: {}, resources: [] });
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

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.reverse()) await undo().catch(() => {});
  cleanup = [];
  vi.restoreAllMocks();
});

/** The view's page, with a link in its body to a task the view shows. */
const VIEW_PAGE = page(snapshotOnPage).replace('<body>', '<body><a id="bread" href="../../Ops/Knowledge/Tasks/Bread.md">Bread</a>');

/** The real server, and a real client connected to it, as a host holds one. */
async function connectServer(): Promise<Client> {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const config: HexisMcpConfig = { baseUrl: base, connectionKey: 'bevel_e2e' };
  const handle = await createHexisMcpServer(config, '0.0.0', {
    catalogCheck: false,
    views: { callKb: fakeKb(VIEW_PAGE) },
  });
  const client = new Client({ name: 'host', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => {
    await client.close();
    await handle.shutdown();
  });
  return client;
}

type Message = Record<string, unknown>;

/**
 * The postMessage channel between a host and its frame, as ext-apps' own
 * PostMessageTransport is: the view posts to its `window.parent`, the host
 * posts into the frame's window. Each message crosses as a copy, later, as a
 * structured clone does.
 */
class FrameTransport {
  onmessage?: (message: Message) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  win: Window | null = null;
  /** What the view sees as `window.parent`. */
  readonly parent = {
    postMessage: (message: unknown) => {
      const copy = structuredClone(message) as Message;
      setTimeout(() => this.onmessage?.(copy), 0);
    },
  };
  async start(): Promise<void> {}
  async send(message: Message): Promise<void> {
    const win = this.win;
    if (!win) throw new Error('no frame to post into');
    const data = structuredClone(message);
    setTimeout(() => win.dispatchEvent(new win.MessageEvent('message', { data, source: this.parent as never })), 0);
  }
  async close(): Promise<void> {
    this.onclose?.();
  }
}

/**
 * Loads `html` into a frame of its own, as a browser parses it: the head's
 * scripts run while the document is still loading (so the compact
 * presentation waits for DOMContentLoaded, as in a browser), then the body's.
 */
function openFrame(html: string, transport: FrameTransport): Window {
  const win = new Window({ url: 'https://host.example/frame', width: 390, height: 800 });
  cleanup.push(() => win.happyDOM.close());
  transport.win = win;
  const doc = win.document;
  let state: DocumentReadyState = 'loading';
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => state });
  Object.defineProperty(win, 'parent', { configurable: true, value: transport.parent });
  const parsed = new win.DOMParser().parseFromString(html, 'text/html');
  doc.body.innerHTML = parsed.body.innerHTML;
  for (const script of parsed.querySelectorAll('script')) {
    // The frame's own globals: its timers end with it.
    new Function('window', 'document', 'navigator', 'globalThis', 'ResizeObserver', 'setTimeout', 'clearTimeout', script.textContent ?? '')(
      win,
      doc,
      win.navigator,
      win,
      win.ResizeObserver,
      win.setTimeout.bind(win),
      win.clearTimeout.bind(win),
    );
  }
  state = 'complete';
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  return win;
}

/** A host for one view: AppBridge, its tool calls proxied to `client`, links and messages recorded. */
async function host(client: Client) {
  const opened: string[] = [];
  const said: string[] = [];
  const transport = new FrameTransport();
  const bridge = new AppBridge(
    null,
    { name: 'hexis-test-host', version: '1.0.0' },
    { openLinks: {}, serverTools: {} },
    { hostContext: { displayMode: 'inline', platform: 'mobile', availableDisplayModes: ['inline', 'fullscreen'] } },
  );
  bridge.oncalltool = async (params) => (await client.callTool(params)) as never;
  bridge.onopenlink = async ({ url }) => {
    opened.push(url);
    return {};
  };
  bridge.onmessage = async ({ content }) => {
    said.push(content.map((c) => ('text' in c ? c.text : '')).join(''));
    return {};
  };
  // A view whose handshake the host rejects never initializes: say so, rather than wait out the test.
  const initialized = new Promise<void>((resolve, reject) => {
    bridge.oninitialized = () => resolve();
    const late = setTimeout(() => reject(new Error('the view never completed its handshake with the host')), 10_000);
    cleanup.push(async () => clearTimeout(late));
  });
  await bridge.connect(transport as never);
  cleanup.push(() => bridge.close());
  return { bridge, transport, initialized, opened, said };
}

type Graph = { nodes: Map<string, unknown> };
const bevelOf = (win: Window) => (win as unknown as { bevel: { buildGraph(): Promise<Graph>; openNode(href: string): void } }).bevel;
const click = (win: Window, selector: string): void => {
  const el = win.document.querySelector(selector) as unknown as { click(): void } | null;
  if (!el) throw new Error(`nothing at ${selector}`);
  el.click();
};

describe('a knowledge view in a real MCP Apps host', () => {
  it('takes a tool result, opens a link and sends a change, each through the host and the server', { timeout: 60_000 }, async () => {
    const client = await connectServer();
    // What a host does when the model calls the view's tool: call it, read the
    // page its result points at, render that page, hand it the result.
    const tool = (await client.listTools()).tools.find((t) => t.name === 'show_to_do_list');
    const uri = (tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
    expect(uri).toBe('ui://hexis/views/to_do_list.html');
    const result = (await client.callTool({ name: 'show_to_do_list', arguments: {} })) as CallToolResult;
    const html = ((await client.readResource({ uri: uri! })).contents[0] as { text: string }).text;
    const h = await host(client);
    const win = openFrame(html, h.transport);
    await h.initialized;
    await h.bridge.sendToolResult(result);

    // Live data, read by the server, through the host's tool result.
    const graph = await bevelOf(win).buildGraph();
    expect([...graph.nodes.keys()].sort()).toEqual([
      'KnowledgeBase/Ops/Knowledge/Tasks/Bread.md',
      'KnowledgeBase/Ops/Knowledge/Tasks/Dentist.md',
    ]);

    // A link in the page and one a script opens: resolved by the server, opened by the host.
    click(win, '#bread');
    bevelOf(win).openNode('/workspace/main/knowledge-base/KnowledgeBase/Ops/Knowledge/Tasks/Dentist.md');
    await vi.waitFor(() =>
      expect([...h.opened].sort()).toEqual([
        `${base}/workspace/main/knowledge-base/KnowledgeBase/Ops/Knowledge/Tasks/Bread.md`,
        `${base}/workspace/main/knowledge-base/KnowledgeBase/Ops/Knowledge/Tasks/Dentist.md`,
      ]),
    );

    // A change made in the compact view, sent to the chat as one message.
    await vi.waitFor(() => expect(win.document.querySelector('[data-act="open-item"][data-path$="Bread.md"]')).not.toBeNull());
    click(win, '[data-act="open-item"][data-path$="Bread.md"]');
    click(win, '[data-act="toggle-done"]');
    click(win, '[data-act="send"]');
    await vi.waitFor(() => expect(h.said).toHaveLength(1));
    expect(h.said[0]).toContain('In KnowledgeBase/Ops/Knowledge/Tasks/Bread.md ("Bread"), set Status to done');
  });

  it('reads live data through the host when no tool result reaches the view', { timeout: 60_000 }, async () => {
    const client = await connectServer();
    const html = ((await client.readResource({ uri: 'ui://hexis/views/to_do_list.html' })).contents[0] as { text: string }).text;
    const h = await host(client);
    const win = openFrame(html, h.transport);
    await h.initialized;
    await h.bridge.sendToolCancelled({});
    const graph = await bevelOf(win).buildGraph();
    expect(graph.nodes.size).toBe(2);
  });
});
