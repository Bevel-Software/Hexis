import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_APP_MIME_TYPE, MCP_APP_URI_SCHEME } from '@bevel-software/platform-mcp-core';
import { OPEN_PAGE_TOOL } from '../embed.tools.js';
import {
  isFrameableOrigin,
  McpAppService,
  MCP_APP_SANDBOX_DOMAIN,
  OPEN_PAGE_VIEW_URI,
  originOf,
} from '../mcp-app.js';
import { createMcpAppRoutes } from '../mcp-app.routes.js';

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const PUBLIC = 'https://hexis.example';

describe('the open_page view', () => {
  it('is named by the tool and served under the MCP App media type', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    expect(manifest.tools[OPEN_PAGE_TOOL]).toEqual({ resourceUri: OPEN_PAGE_VIEW_URI });
    expect(OPEN_PAGE_VIEW_URI.startsWith(MCP_APP_URI_SCHEME)).toBe(true);
    expect(manifest.resources).toHaveLength(1);
    expect(manifest.resources[0]).toMatchObject({
      uri: OPEN_PAGE_VIEW_URI,
      mimeType: MCP_APP_MIME_TYPE,
    });
  });

  /**
   * The view frames ONE address: the `/embed` page of the deployment that
   * served it. Anything wider would buy nothing and widen what a host's
   * sandbox permits.
   */
  it('allows framing exactly the deployment own public origin', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: `${PUBLIC}/sub/path` }).manifest();
    expect(manifest.resources[0].ui.csp?.frameDomains).toEqual([PUBLIC]);
  });

  /**
   * A host derives the view's opaque origin from the sandbox domain, so a
   * value that changed per render would throw the sandbox's storage away on
   * every call.
   */
  it('sets a STABLE sandbox domain — the same for two deployments and two reads', async () => {
    const a = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    const b = await new McpAppService({ publicFrontendUrl: 'https://other.example' }).manifest();
    expect(a.resources[0].ui.domain).toBe(MCP_APP_SANDBOX_DOMAIN);
    expect(b.resources[0].ui.domain).toBe(MCP_APP_SANDBOX_DOMAIN);
    const again = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    expect(again.resources[0].ui.domain).toBe(MCP_APP_SANDBOX_DOMAIN);
  });

  it('is the HTML that frames the embed and relays a link, and nothing that renders content', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    const html = manifest.resources[0].text;
    expect(html).toContain('ui/initialize');
    expect(html).toContain('ui/notifications/tool-result');
    expect(html).toContain('ui/open-link');
    expect(html).toContain('bevel-embed-open');
    expect(html).toContain('structuredContent');
    // No second rendering path: the view frames the page, it does not draw it.
    expect(html).not.toContain('marked');
    expect(html).not.toContain('<markdown');
  });

  it('serves the view by URI, and nothing else', async () => {
    const apps = new McpAppService({ publicFrontendUrl: PUBLIC });
    expect(await apps.resource(OPEN_PAGE_VIEW_URI)).not.toBeNull();
    expect(await apps.resource('ui://hexis/not-a-view.html')).toBeNull();
  });

  it('reads the view once and caches it — resources/read is on a handshake path', async () => {
    const apps = new McpAppService({ publicFrontendUrl: PUBLIC });
    const [a, b] = await Promise.all([apps.manifest(), apps.manifest()]);
    expect(a).toBe(b);
  });
});

describe('originOf / isFrameableOrigin', () => {
  it('reduces an address to its origin, and refuses one that does not parse', () => {
    expect(originOf(`${PUBLIC}/sub?x=1#y`)).toBe(PUBLIC);
    expect(originOf('not a url')).toBeNull();
  });

  /**
   * A host runs an app view in a sandboxed https iframe, and no browser lets
   * an https document frame a plain-http one — so a deployment reached over
   * http has no embedded view, and `open_page` says so.
   */
  it.each([
    ['https', 'https://hexis.example', true],
    ['plain http', 'http://hexis.example', false],
    ['localhost over http', 'http://localhost:3001', false],
    ['nonsense', 'not a url', false],
  ])('%s is frameable: %s', (_label, url, expected) => {
    expect(isFrameableOrigin(url)).toBe(expected);
  });
});

describe('the manifest route the local MCP server reads', () => {
  async function serve() {
    const app = express();
    const pass: express.RequestHandler = (_req, _res, next) => next();
    app.use('/api', createMcpAppRoutes(new McpAppService({ publicFrontendUrl: PUBLIC }), pass));
    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }

  it('answers the tool metadata and the view, so the local server can serve both', async () => {
    const base = await serve();
    const res = await fetch(`${base}/api/agent/mcp-app`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tools: Record<string, { resourceUri: string }>;
      resources: Array<{ uri: string; mimeType: string; text: string; ui: Record<string, unknown> }>;
    };
    expect(body.tools[OPEN_PAGE_TOOL].resourceUri).toBe(OPEN_PAGE_VIEW_URI);
    expect(body.resources[0].mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(body.resources[0].text).toContain('ui/initialize');
    expect(body.resources[0].ui).toMatchObject({ domain: MCP_APP_SANDBOX_DOMAIN });
  });

  it('is behind the agent credential, like the rest of that surface', async () => {
    const app = express();
    const refuse: express.RequestHandler = (_req, res) => {
      res.status(401).json({ error: 'Unauthenticated' });
    };
    app.use('/api', createMcpAppRoutes(new McpAppService({ publicFrontendUrl: PUBLIC }), refuse));
    server = app.listen(0);
    await new Promise<void>((r) => server!.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    expect((await fetch(`${base}/api/agent/mcp-app`)).status).toBe(401);
  });
});

/**
 * A deployment whose packaged view cannot be read must serve NO app rather
 * than half of one: a `resourceUri` with no resource behind it would have a
 * host preload a failure and show an empty frame where the tool's text was.
 */
describe('a view that cannot be read', () => {
  it('leaves the deployment with no apps at all', async () => {
    // The REAL build, pointed at a folder with no view in it — the read
    // fails exactly as it does in an image that shipped without `mcp-app/`,
    // and nothing packaged is touched under a parallel test run.
    const empty = mkdtempSync(path.join(tmpdir(), 'no-mcp-app-'));
    try {
      const service = new McpAppService({ publicFrontendUrl: PUBLIC, viewDir: empty });
      const manifest = await service.manifest();
      expect(manifest.tools).toEqual({});
      expect(manifest.resources).toEqual([]);
      expect(await service.resource(OPEN_PAGE_VIEW_URI)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
