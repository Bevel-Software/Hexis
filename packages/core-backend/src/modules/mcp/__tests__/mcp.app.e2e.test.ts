import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_APP_MIME_TYPE, MCP_APP_UI_META_KEY } from '@bevel-software/platform-mcp-core';
import { createMcpRoutes } from '../mcp.routes.js';
import { McpService } from '../mcp.service.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { toolDef } from '../../tool-helpers/tool-def.js';
import { McpAppService, OPEN_PAGE_VIEW_URI } from '../../embed/mcp-app.js';
import { OPEN_PAGE_TOOL } from '../../embed/embed.tools.js';

/**
 * The MCP App, over the REAL Streamable-HTTP transport with the official SDK
 * client — the criterion as a host actually observes it: `tools/list` carries
 * the view on `open_page`, `resources/list` offers it under the MCP App media
 * type, and `resources/read` hands back the view with the framing metadata.
 */

const KEY = 'bevel_key_user_a';
const PUBLIC = 'https://hexis.example';

const bearerOf = (req: express.Request) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
const fakeAuth: RequestHandler = (req, res, next) => {
  if (bearerOf(req) !== KEY) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.userId = 'user-A';
  req.externalApiKeyId = 'tok-A';
  next();
};

let httpServer: HttpServer | null = null;
let client: Client | null = null;

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  if (httpServer) {
    httpServer.closeAllConnections();
    await new Promise<void>((r) => httpServer!.close(() => r()));
  }
  httpServer = null;
});

/** The platform: the real proxy, the real routes, and `open_page` in the catalog. */
async function connect(opts: { serveApps?: boolean } = {}) {
  const app = express();
  app.use(express.json());

  const registry = new ToolRegistry();
  for (const name of [OPEN_PAGE_TOOL, 'read_file']) {
    registry.registerExternalTool(
      toolDef({
        name,
        description: `the ${name} tool`,
        path: `/api/agent/tools/${name}`,
        inputs: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
      }),
    );
  }
  const toolRoutes = express.Router();
  toolRoutes.use(createManualRoutes(registry, fakeAuth, async () => 'a@x.io'));
  toolRoutes.post('/agent/tools/:name', (req, res) =>
    res.json(
      req.params.name === OPEN_PAGE_TOOL
        ? { path: 'Data/Thing.md', content: '# Thing', embedUrl: `${PUBLIC}/embed?token=t`, appUrl: PUBLIC, branch: 'main' }
        : { ok: true },
    ),
  );

  httpServer = app.listen(0);
  await new Promise<void>((r) => httpServer!.once('listening', () => r()));
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const service = new McpService(
    {
      loopbackBaseUrl: baseUrl,
      manualName: 'KNOWLEDGE_BASE',
      spillStore: new SpillStore(join(tmpdir(), 'bevel-test-spills')),
      publicFrontendUrl: PUBLIC,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    // A deployment with no apps is the degraded shape: no capability, no view.
    opts.serveApps === false ? undefined : new McpAppService({ publicFrontendUrl: PUBLIC }),
  );
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', toolRoutes);

  client = new Client({ name: 'test-host', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }),
  );
  return client;
}

describe('the hosted MCP endpoint serves the open_page view', () => {
  it('lists open_page carrying UI metadata that names a ui:// resource', async () => {
    const host = await connect();
    const { tools } = await host.listTools();
    const openPage = tools.find((t) => t.name === OPEN_PAGE_TOOL);
    expect(openPage).toBeDefined();
    expect(openPage!._meta).toEqual({ [MCP_APP_UI_META_KEY]: { resourceUri: OPEN_PAGE_VIEW_URI } });
    expect(OPEN_PAGE_VIEW_URI.startsWith('ui://')).toBe(true);
    // And only that tool: `read_file` is deliberately untouched.
    expect(tools.find((t) => t.name === 'read_file')!._meta).toBeUndefined();
  }, 30_000);

  it('lists the view with the MCP App media type', async () => {
    const host = await connect();
    const { resources } = await host.listResources();
    const view = resources.find((r) => r.uri === OPEN_PAGE_VIEW_URI);
    expect(view).toBeDefined();
    expect(view!.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(view!._meta).toMatchObject({
      [MCP_APP_UI_META_KEY]: { csp: { frameDomains: [PUBLIC] } },
    });
  }, 30_000);

  it('reads the view, framing exactly the deployment own origin and asking for no sandbox domain', async () => {
    const host = await connect();
    const read = await host.readResource({ uri: OPEN_PAGE_VIEW_URI });
    expect(read.contents).toHaveLength(1);
    const [content] = read.contents as Array<{ mimeType: string; text: string; _meta: Record<string, unknown> }>;
    expect(content.mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(content.text).toContain('ui/initialize');
    expect(content._meta[MCP_APP_UI_META_KEY]).toMatchObject({
      csp: { frameDomains: [PUBLIC] },
      prefersBorder: false,
    });
    // The host's default sandbox: the field's format is each host's own, and
    // a value a host rejects is a view that never renders.
    expect(content._meta[MCP_APP_UI_META_KEY]).not.toHaveProperty('domain');
  }, 30_000);

  it('refuses a resource it does not serve, naming the ones it does', async () => {
    const host = await connect();
    await expect(host.readResource({ uri: 'ui://hexis/not-a-view.html' })).rejects.toThrow(
      /No resource at ui:\/\/hexis\/not-a-view\.html/,
    );
  }, 30_000);

  /**
   * A deployment that serves no view must not declare the capability: a
   * client would list resources and be told the method does not exist, which
   * reads as a broken endpoint rather than as "this one has no apps".
   */
  it('declares no resources capability when the deployment serves no app', async () => {
    const host = await connect({ serveApps: false });
    expect(host.getServerCapabilities()?.resources).toBeUndefined();
    const { tools } = await host.listTools();
    // Every tool is still listed, and still carries no view.
    expect(tools.find((t) => t.name === OPEN_PAGE_TOOL)).toBeDefined();
    expect(tools.find((t) => t.name === OPEN_PAGE_TOOL)!._meta).toBeUndefined();
  }, 30_000);

  /**
   * The view frames `structuredContent.embedUrl` — it has nowhere else to
   * read it — so a tool with a view must answer structured content as well
   * as the text the model reads. A tool without one answers text alone.
   */
  it('answers open_page with structured content the view can read, and read_file without', async () => {
    const host = await connect();
    const opened = await host.callTool({ name: OPEN_PAGE_TOOL, arguments: { path: 'Data/Thing.md' } });
    expect(opened.structuredContent).toMatchObject({ embedUrl: `${PUBLIC}/embed?token=t`, branch: 'main' });
    expect((opened.content as Array<{ type: string; text: string }>)[0].text).toContain('embedUrl');
    const read = await host.callTool({ name: 'read_file', arguments: { path: 'Data/Thing.md' } });
    expect(read.structuredContent).toBeUndefined();
  }, 30_000);

  it('declares the resources capability when it does', async () => {
    const host = await connect();
    expect(host.getServerCapabilities()?.resources).toBeDefined();
  }, 30_000);
});
