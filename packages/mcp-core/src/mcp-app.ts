/**
 * The MCP Apps extension (`io.modelcontextprotocol/ui`, specification
 * 2026-01-26), as much of it as a SERVER has to speak.
 *
 * The pattern is two primitives tied together by one URI: a tool whose
 * `_meta.ui.resourceUri` names a `ui://` resource, and that resource — an HTML
 * page served under {@link MCP_APP_MIME_TYPE} — which the host renders in an
 * iframe and then pushes the tool's result into. A host without the extension
 * sees an ordinary tool with an ordinary text result and ignores the metadata,
 * which is why the tool's answer must stand on its own.
 *
 * Deliberately no dependency: the extension's SDK would be a new package on
 * both the server and the view, and the wire shape it would hide is the three
 * literals below (see the Specification's Decision 10). Hexis tracks the
 * specification by hand instead.
 *
 * Lives in `mcp-core` because BOTH surfaces serve the same view: the hosted
 * proxy from the deployment it runs in, and `hexis-mcp` by fetching it from
 * the deployment it bridges. One definition, so the two cannot drift.
 */

/** The `_meta` key the extension's metadata rides under, on a tool and on a resource alike. */
export const MCP_APP_UI_META_KEY = 'ui';

/**
 * The media type of an MCP App view. A host that supports the extension
 * recognises an app by this and nothing else; a non-conforming explicit type
 * is rejected rather than coerced, so it is spelled once, here.
 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/** The `ui://` scheme every app resource's URI uses. */
export const MCP_APP_URI_SCHEME = 'ui://';

/** A tool's UI metadata: which view renders its result. */
export interface McpAppToolUi {
  /** The `ui://` URI of the view resource. */
  resourceUri: string;
}

/** A view resource's UI metadata: what the host's sandbox may do with it. */
export interface McpAppResourceUi {
  /**
   * What the sandbox may load from outside itself. `frameDomains` are the
   * origins the view may put in an iframe — for Hexis, exactly the
   * deployment's own public origin, because the view's whole job is to frame
   * this deployment's `/embed` page.
   */
  csp?: {
    frameDomains?: string[];
    connectDomains?: string[];
    resourceDomains?: string[];
  };
  /**
   * The stable sandbox domain the host gives the view. Stable matters: the
   * host derives the iframe's opaque origin from it, so a value that changed
   * per render would throw away the sandbox's storage on every call.
   */
  domain?: string;
  /** Whether the host should draw a border around the view. */
  prefersBorder?: boolean;
}

/** One MCP App view, as `resources/list` and `resources/read` answer for it. */
export interface McpAppResource {
  /** `ui://…` — the URI a tool's `resourceUri` points at. */
  uri: string;
  name: string;
  title?: string;
  description?: string;
  /** Always {@link MCP_APP_MIME_TYPE}. */
  mimeType: string;
  /** The view's HTML. */
  text: string;
  ui: McpAppResourceUi;
}

/**
 * Everything a surface needs to serve a deployment's MCP Apps: which tools
 * carry UI metadata, and the views they name.
 *
 * `hexis-mcp` fetches exactly this shape over HTTP from the deployment, so
 * the local server advertises the same apps as the hosted endpoint without
 * knowing anything about what they render.
 */
export interface McpAppManifest {
  /** Tool name → its UI metadata. */
  tools: Record<string, McpAppToolUi>;
  resources: McpAppResource[];
}

/** The `_meta` object a tool carrying a view advertises. */
export function toolUiMeta(ui: McpAppToolUi): Record<string, unknown> {
  return { [MCP_APP_UI_META_KEY]: { resourceUri: ui.resourceUri } };
}

/** The `_meta` object a view resource advertises, on both list and read. */
export function resourceUiMeta(ui: McpAppResourceUi): Record<string, unknown> {
  return { [MCP_APP_UI_META_KEY]: { ...ui } };
}

/** A resource's listing entry (no content), as `resources/list` returns it. */
export function toListedResource(resource: McpAppResource): {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType: string;
  _meta: Record<string, unknown>;
} {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.title !== undefined ? { title: resource.title } : {}),
    ...(resource.description !== undefined ? { description: resource.description } : {}),
    mimeType: resource.mimeType,
    _meta: resourceUiMeta(resource.ui),
  };
}

/**
 * A resource's content, as `resources/read` returns it. The metadata rides
 * the CONTENTS entry as well as the listing: a host that preloads a view
 * straight from a tool's `resourceUri` never saw the listing, and the CSP is
 * what decides whether its sandbox may frame anything at all.
 */
export function toReadResourceResult(resource: McpAppResource): {
  contents: Array<{ uri: string; mimeType: string; text: string; _meta: Record<string, unknown> }>;
} {
  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.text,
        _meta: resourceUiMeta(resource.ui),
      },
    ],
  };
}

/**
 * Parse a manifest off the wire (the local server's fetch from a deployment),
 * keeping only what is well-formed. A deployment too old to serve one, or one
 * whose answer is a proxy's HTML, must leave the local server with NO apps
 * rather than with a half-built one — the tools it bridges still work.
 */
export function parseMcpAppManifest(body: unknown): McpAppManifest {
  const empty: McpAppManifest = { tools: {}, resources: [] };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return empty;
  const raw = body as { tools?: unknown; resources?: unknown };
  const tools: Record<string, McpAppToolUi> = {};
  if (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) {
    for (const [name, value] of Object.entries(raw.tools as Record<string, unknown>)) {
      const uri = (value as { resourceUri?: unknown })?.resourceUri;
      if (typeof uri === 'string' && uri.startsWith(MCP_APP_URI_SCHEME)) {
        tools[name] = { resourceUri: uri };
      }
    }
  }
  const resources: McpAppResource[] = [];
  if (Array.isArray(raw.resources)) {
    for (const entry of raw.resources) {
      if (!entry || typeof entry !== 'object') continue;
      const r = entry as Partial<McpAppResource>;
      // A view with no URI or no HTML is nothing a host can render, and a
      // media type that is not the app one would be rejected downstream
      // anyway — drop it here, where the reason is still legible.
      if (typeof r.uri !== 'string' || !r.uri.startsWith(MCP_APP_URI_SCHEME)) continue;
      if (typeof r.text !== 'string' || r.text === '') continue;
      if (r.mimeType !== MCP_APP_MIME_TYPE) continue;
      resources.push({
        uri: r.uri,
        name: typeof r.name === 'string' && r.name ? r.name : r.uri,
        ...(typeof r.title === 'string' ? { title: r.title } : {}),
        ...(typeof r.description === 'string' ? { description: r.description } : {}),
        mimeType: MCP_APP_MIME_TYPE,
        text: r.text,
        ui:
          r.ui && typeof r.ui === 'object' && !Array.isArray(r.ui)
            ? (r.ui as McpAppResourceUi)
            : {},
      });
    }
  }
  // Only tools whose view actually arrived: a `resourceUri` pointing at a
  // resource this surface cannot serve would have a host preload a 404 and
  // show the reader an empty frame where the text used to be.
  const served = new Set(resources.map((r) => r.uri));
  for (const name of Object.keys(tools)) {
    if (!served.has(tools[name].resourceUri)) delete tools[name];
  }
  return { tools, resources };
}
