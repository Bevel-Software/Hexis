import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_APP_MIME_TYPE, MCP_APP_URI_SCHEME } from '@bevel-software/platform-mcp-core';
import { OPEN_PAGE_TOOL } from '../embed.tools.js';
import {
  isSandboxReachableOrigin,
  McpAppService,
  OPEN_PAGE_VIEW_URI_PREFIX,
  openPageViewUri,
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
    expect(manifest.resources).toHaveLength(1);
    const { uri } = manifest.resources[0];
    expect(manifest.tools[OPEN_PAGE_TOOL]).toEqual({ resourceUri: uri });
    expect(uri.startsWith(MCP_APP_URI_SCHEME)).toBe(true);
    expect(uri.startsWith(OPEN_PAGE_VIEW_URI_PREFIX)).toBe(true);
    expect(manifest.resources[0]).toMatchObject({ uri, mimeType: MCP_APP_MIME_TYPE });
  });

  /**
   * A host caches a view by its URI, so a changed view under an unchanged
   * URI is served stale until the host happens to refetch — Claude kept
   * rendering the cached, pre-#391 view, the one that goes blank. Naming the
   * view by its content makes every change a new URI.
   */
  it('is named by its content, so a changed view is a new resource and the same view the same one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mcp-app-view-'));
    try {
      const at = async (html: string) => {
        writeFileSync(path.join(dir, 'page.html'), html);
        return (await new McpAppService({ publicFrontendUrl: PUBLIC, viewDir: dir }).manifest()).resources[0].uri;
      };
      const first = await at('<!doctype html><p>one</p>');
      const same = await at('<!doctype html><p>one</p>');
      const changed = await at('<!doctype html><p>two</p>');
      expect(first).toMatch(/^ui:\/\/hexis\/page-[0-9a-f]{12}\.html$/);
      expect(same).toBe(first);
      expect(changed).not.toBe(first);
      expect(first).toBe(openPageViewUri('<!doctype html><p>one</p>'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The view reaches ONE origin — the deployment that served it — for two
   * things: fetching its build manifest and the token-only embed API
   * (connect), and loading the embed bundle (resources). It frames nothing:
   * Claude's host drops `frameDomains` and pins `frame-src` to `'self'`,
   * which is why the view runs the bundle in its own document.
   */
  it('declares exactly the deployment own public origin for connecting and loading, and no frames', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: `${PUBLIC}/sub/path` }).manifest();
    expect(manifest.resources[0].ui.csp).toEqual({ connectDomains: [PUBLIC], resourceDomains: [PUBLIC] });
  });

  /**
   * The sandbox `domain` field's format is each host's own to define and
   * validate, and a value a host rejects is a view that never renders. The
   * view keeps no storage and has no OAuth callback, so it asks for no
   * dedicated origin and takes the host's default sandbox.
   */
  it('asks the host for no sandbox domain of its own', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    expect(manifest.resources[0].ui).not.toHaveProperty('domain');
    expect(manifest.resources[0].ui.prefersBorder).toBe(false);
  });

  it('is the HTML that runs the deployment embed bundle and relays a link, and nothing that renders content', async () => {
    const manifest = await new McpAppService({ publicFrontendUrl: PUBLIC }).manifest();
    const html = manifest.resources[0].text;
    expect(html).toContain('ui/initialize');
    expect(html).toContain('ui/notifications/tool-result');
    expect(html).toContain('ui/open-link');
    expect(html).toContain('structuredContent');
    // The deployment's embed bundle, found through its build manifest and
    // handed the page — not a frame of `/embed`, which a chat host's sandbox
    // blocks.
    expect(html).toContain('embed-manifest.json');
    expect(html).toContain('__HEXIS_EMBED__');
    expect(html).not.toContain('<iframe');
    // No second rendering path: the view runs the app's renderers, it does not draw the page itself.
    expect(html).not.toContain('marked');
    expect(html).not.toContain('<markdown');
  });

  it('serves the view by URI, and nothing else', async () => {
    const apps = new McpAppService({ publicFrontendUrl: PUBLIC });
    const { uri } = (await apps.manifest()).resources[0];
    expect(await apps.resource(uri)).not.toBeNull();
    expect(await apps.resource('ui://hexis/not-a-view.html')).toBeNull();
    // The unversioned name the view had before #391 is not served either: a
    // host still asking for it gets "no such resource", not a stale view.
    expect(await apps.resource('ui://hexis/page.html')).toBeNull();
  });

  it('reads the view once and caches it — resources/read is on a handshake path', async () => {
    const apps = new McpAppService({ publicFrontendUrl: PUBLIC });
    const [a, b] = await Promise.all([apps.manifest(), apps.manifest()]);
    expect(a).toBe(b);
  });
});

describe('originOf / isSandboxReachableOrigin', () => {
  it('reduces an address to its origin, and refuses one that does not parse', () => {
    expect(originOf(`${PUBLIC}/sub?x=1#y`)).toBe(PUBLIC);
    expect(originOf('not a url')).toBeNull();
  });

  /**
   * A host runs an app view in a sandboxed https iframe, and no browser lets
   * an https document load scripts from, or fetch from, a plain-http origin —
   * so a deployment reached over http has no embedded view, and `open_page`
   * says so.
   */
  it.each([
    ['https', 'https://hexis.example', true],
    ['plain http', 'http://hexis.example', false],
    ['localhost over http', 'http://localhost:3001', false],
    ['nonsense', 'not a url', false],
  ])('%s is reachable from a sandbox: %s', (_label, url, expected) => {
    expect(isSandboxReachableOrigin(url)).toBe(expected);
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
    expect(body.tools[OPEN_PAGE_TOOL].resourceUri).toBe(body.resources[0].uri);
    expect(body.resources[0].uri.startsWith(OPEN_PAGE_VIEW_URI_PREFIX)).toBe(true);
    expect(body.resources[0].mimeType).toBe(MCP_APP_MIME_TYPE);
    expect(body.resources[0].text).toContain('ui/initialize');
    expect(body.resources[0].ui).toMatchObject({
      csp: { connectDomains: [PUBLIC], resourceDomains: [PUBLIC] },
      prefersBorder: false,
    });
    expect(body.resources[0].ui).not.toHaveProperty('domain');
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
      expect(await service.resource(openPageViewUri(''))).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
