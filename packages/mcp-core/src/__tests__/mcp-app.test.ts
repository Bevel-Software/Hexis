import { describe, expect, it } from 'vitest';
import {
  MCP_APP_MIME_TYPE,
  MCP_APP_UI_META_KEY,
  parseMcpAppManifest,
  toListedResource,
  toReadResourceResult,
  type McpAppResource,
} from '../mcp-app.js';
import { toListedTool, type ProxiedTool } from '../proxied-tool.js';

const VIEW: McpAppResource = {
  uri: 'ui://hexis/page.html',
  name: 'knowledge-base-page',
  title: 'Knowledge base page',
  mimeType: MCP_APP_MIME_TYPE,
  text: '<!doctype html><title>view</title>',
  ui: { csp: { frameDomains: ['https://hexis.example'] }, domain: 'sandbox.invalid', prefersBorder: false },
};

const TOOL: ProxiedTool = {
  utcpName: 'KNOWLEDGE_BASE.open_page',
  mcpName: 'open_page',
  description: 'show a page',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  manualName: 'KNOWLEDGE_BASE',
};

describe('a tool that carries a view', () => {
  it('advertises the view under the extension _meta key', () => {
    const listed = toListedTool({ ...TOOL, ui: { resourceUri: VIEW.uri } })!;
    expect(listed._meta).toEqual({ [MCP_APP_UI_META_KEY]: { resourceUri: VIEW.uri } });
  });

  /** A client without the extension must read the tool exactly as before. */
  it('carries no _meta when it has no view', () => {
    expect(toListedTool(TOOL)).not.toHaveProperty('_meta');
  });

  it('keeps the name, description and schema untouched either way', () => {
    const plain = toListedTool(TOOL)!;
    const withView = toListedTool({ ...TOOL, ui: { resourceUri: VIEW.uri } })!;
    expect(withView.name).toBe(plain.name);
    expect(withView.description).toBe(plain.description);
    expect(withView.inputSchema).toEqual(plain.inputSchema);
  });

  /**
   * The name and schema guards exist so one bad tool cannot blank a client's
   * whole toolset; a view must not sneak a tool past them.
   */
  it('is still dropped when its name cannot be listed', () => {
    expect(toListedTool({ ...TOOL, mcpName: 'bad name!', ui: { resourceUri: VIEW.uri } })).toBeNull();
  });
});

describe('a view resource on the wire', () => {
  it('lists with the media type and the sandbox metadata, and without its HTML', () => {
    const listed = toListedResource(VIEW);
    expect(listed).toMatchObject({ uri: VIEW.uri, name: VIEW.name, mimeType: MCP_APP_MIME_TYPE });
    expect(listed._meta).toEqual({ [MCP_APP_UI_META_KEY]: VIEW.ui });
    expect(listed).not.toHaveProperty('text');
  });

  /**
   * The metadata rides the CONTENTS as well as the listing: a host that
   * preloads a view straight from a tool's `resourceUri` never saw the
   * listing, and the CSP is what decides whether its sandbox may frame
   * anything at all.
   */
  it('reads with the HTML and the SAME metadata the listing carried', () => {
    const read = toReadResourceResult(VIEW);
    expect(read.contents).toHaveLength(1);
    expect(read.contents[0]).toMatchObject({ uri: VIEW.uri, mimeType: MCP_APP_MIME_TYPE, text: VIEW.text });
    expect(read.contents[0]._meta).toEqual(toListedResource(VIEW)._meta);
  });
});

describe('parseMcpAppManifest', () => {
  it('reads a well-formed manifest', () => {
    const parsed = parseMcpAppManifest({ tools: { open_page: { resourceUri: VIEW.uri } }, resources: [VIEW] });
    expect(parsed.tools).toEqual({ open_page: { resourceUri: VIEW.uri } });
    expect(parsed.resources).toHaveLength(1);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an array', []],
    ['a proxy HTML page', '<!doctype html>'],
    ['an empty object', {}],
  ])('answers no apps for %s', (_label, body) => {
    expect(parseMcpAppManifest(body)).toEqual({ tools: {}, resources: [] });
  });

  it.each([
    ['no uri', { ...VIEW, uri: undefined }],
    ['a uri that is not ui://', { ...VIEW, uri: 'https://hexis.example/view.html' }],
    ['no HTML', { ...VIEW, text: '' }],
    ['the wrong media type', { ...VIEW, mimeType: 'text/html' }],
  ])('drops a resource with %s', (_label, resource) => {
    expect(parseMcpAppManifest({ tools: {}, resources: [resource] }).resources).toEqual([]);
  });

  /**
   * A `resourceUri` pointing at a resource this surface cannot serve would
   * have a host preload a 404 and show the reader an empty frame where the
   * tool's text used to be. So the tool loses its view with the resource.
   */
  it('drops a tool whose view did not arrive', () => {
    const parsed = parseMcpAppManifest({
      tools: { open_page: { resourceUri: 'ui://hexis/missing.html' } },
      resources: [VIEW],
    });
    expect(parsed.tools).toEqual({});
    expect(parsed.resources).toHaveLength(1);
  });

  it('drops a tool whose resourceUri is not a ui:// uri', () => {
    const parsed = parseMcpAppManifest({
      tools: { open_page: { resourceUri: 'https://elsewhere.test/view.html' } },
      resources: [VIEW],
    });
    expect(parsed.tools).toEqual({});
  });
});
