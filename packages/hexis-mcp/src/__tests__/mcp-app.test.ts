import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_APP_MIME_TYPE, MCP_APP_UI_META_KEY } from '@bevel-software/platform-mcp-core';
import type { ProxiedTool } from '@bevel-software/platform-mcp-core';
import { REMOTE_MANUAL_NAME } from '../manuals.js';
import { listedTools } from '../server.js';
import { ConnectionKeyRejectedError, fetchMcpApps } from '../deployment.js';

const VIEW_URI = 'ui://hexis/page.html';

const VIEW = {
  uri: VIEW_URI,
  name: 'knowledge-base-page',
  mimeType: MCP_APP_MIME_TYPE,
  text: '<!doctype html><title>view</title>',
  ui: { csp: { frameDomains: ['https://hexis.example'] }, domain: 'sandbox.invalid', prefersBorder: false },
};

function tool(mcpName: string): ProxiedTool {
  return {
    utcpName: `${REMOTE_MANUAL_NAME}.${mcpName}`,
    mcpName,
    description: `the ${mcpName} tool`,
    inputSchema: { type: 'object', properties: {} },
    manualName: REMOTE_MANUAL_NAME,
  };
}

const config = { baseUrl: 'https://hexis.example', connectionKey: 'bevel_k' } as never;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A `fetch` that answers one JSON body with one status. */
function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * The local server bridges a host to a deployment over HTTP. A UTCP manual
 * has nowhere to carry an MCP App view, so the metadata arrives as data — and
 * this server then forwards it on `tools/list` and serves the view itself, so
 * a host connected through it renders a page exactly as one connected
 * straight to the deployment does.
 */
describe('listedTools forwards the deployment view metadata', () => {
  it('puts the view on the tool that carries it, and on no other', () => {
    const listed = listedTools([tool('open_page'), tool('read_file')], {
      open_page: { resourceUri: VIEW_URI },
    });
    const openPage = listed.find((t) => t.name === 'open_page')!;
    const readFile = listed.find((t) => t.name === 'read_file')!;
    expect(openPage._meta).toEqual({ [MCP_APP_UI_META_KEY]: { resourceUri: VIEW_URI } });
    expect(readFile).not.toHaveProperty('_meta');
  });

  /** An inherited property of the views object is not a view somebody published. */
  it('gives no view to a tool named after an Object.prototype member', () => {
    const listed = listedTools([tool('constructor'), tool('toString')], {
      open_page: { resourceUri: VIEW_URI },
    });
    for (const name of ['constructor', 'toString']) {
      expect(listed.find((t) => t.name === name)).not.toHaveProperty('_meta');
    }
  });

  /** A deployment that serves no app leaves every tool exactly as it was. */
  it('carries no metadata when the deployment serves no app', () => {
    const listed = listedTools([tool('open_page')]);
    expect(listed.find((t) => t.name === 'open_page')).not.toHaveProperty('_meta');
  });

  it('still serves the meta-tools and the discovered tools alongside it', () => {
    const names = listedTools([tool('open_page')], { open_page: { resourceUri: VIEW_URI } }).map(
      (t) => t.name,
    );
    expect(names.slice(0, 3)).toEqual(['list_tools', 'tools_info', 'call_tool_chain']);
    expect(names).toContain('open_page');
  });
});

describe('fetchMcpApps', () => {
  it('reads the manifest from the deployment agent surface, with the connection key', async () => {
    const fetchMock = stubFetch({ tools: { open_page: { resourceUri: VIEW_URI } }, resources: [VIEW] });
    const apps = await fetchMcpApps(config);
    expect(apps.tools).toEqual({ open_page: { resourceUri: VIEW_URI } });
    expect(apps.resources[0]).toMatchObject({ uri: VIEW_URI, mimeType: MCP_APP_MIME_TYPE });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hexis.example/api/agent/mcp-app');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bevel_k');
  });

  /**
   * DEGRADES TO NOTHING, and that is the right outcome rather than a
   * fallback: with no manifest every tool is still listed and still callable,
   * and a host shows the tool's text answer — which is what a host without
   * the extension does anyway. Advertising a `resourceUri` this server could
   * not serve would be worse: the host would preload a failure and show an
   * empty frame where the text used to be.
   */
  it.each([
    ['a deployment too old to have the route', 404],
    ['a deployment mid-redeploy', 502],
    ['a deployment that refuses the key for permission', 403],
  ])('answers no apps for %s', async (_label, status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ error: 'nope' }, status);
    expect(await fetchMcpApps(config)).toEqual({ tools: {}, resources: [] });
  });

  it('answers no apps when a proxy answers with HTML instead of JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch('<!doctype html><title>login</title>');
    expect(await fetchMcpApps(config)).toEqual({ tools: {}, resources: [] });
  });

  /**
   * A JSON answer of the WRONG shape — a proxy's `{}`, another protocol's
   * envelope — still answers no apps, but says so: the parser alone would
   * read it as a deployment that serves none, without a word.
   */
  it.each([
    ['an empty object', {}],
    ['an envelope', { data: { tools: {}, resources: [] } }],
    ['resources that are not a list', { tools: {}, resources: {} }],
  ])('names a manifest of the wrong shape (%s) rather than reading it as no apps', async (_label, body) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(body);
    expect(await fetchMcpApps(config)).toEqual({ tools: {}, resources: [] });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('not an MCP App manifest'));
  });

  it('says WHY on stderr, so an app-less server is diagnosable rather than silent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({ error: 'nope' }, 500);
    await fetchMcpApps(config);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('MCP App manifest'));
  });

  /**
   * A rejected key is not about this route: it ends the process everywhere
   * else, and swallowing it here would turn a clear "mint a new key" into a
   * silently app-less server.
   */
  it('lets a rejected connection key through', async () => {
    stubFetch({ error: 'unauthorized' }, 401);
    await expect(fetchMcpApps(config)).rejects.toThrow(ConnectionKeyRejectedError);
  });

  /**
   * On a catalog refresh the manifest already served is passed in: a failed
   * read keeps it (the refresh is marked applied either way, so nothing would
   * read again), while a manifest that reads as empty still replaces it.
   */
  it('keeps the manifest already served when a refresh read fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const served = { tools: { open_page: { resourceUri: VIEW_URI } }, resources: [VIEW] };
    stubFetch({ error: 'nope' }, 502);
    expect(await fetchMcpApps(config, served)).toBe(served);
  });

  /**
   * A route that is definitely gone is not transient: keeping the views would
   * advertise a `ui://` view the deployment no longer serves, and the refresh
   * is marked applied either way, so nothing would read again.
   */
  it.each([404, 410, 403])('drops the views served when a refresh read answers %i', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const served = { tools: { open_page: { resourceUri: VIEW_URI } }, resources: [VIEW] };
    stubFetch({ error: 'gone' }, status);
    expect(await fetchMcpApps(config, served)).toEqual({ tools: {}, resources: [] });
  });

  it('lets a refresh that reads an empty manifest replace the one served', async () => {
    const served = { tools: { open_page: { resourceUri: VIEW_URI } }, resources: [VIEW] };
    stubFetch({ tools: {}, resources: [] });
    expect(await fetchMcpApps(config, served)).toEqual({ tools: {}, resources: [] });
  });

  it('drops a view whose media type is not the MCP App one', async () => {
    stubFetch({
      tools: { open_page: { resourceUri: VIEW_URI } },
      resources: [{ ...VIEW, mimeType: 'text/html' }],
    });
    const apps = await fetchMcpApps(config);
    expect(apps.resources).toEqual([]);
    // And the tool loses the view with it, rather than naming one that is gone.
    expect(apps.tools).toEqual({});
  });
});
