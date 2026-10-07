import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MCP_APP_MIME_TYPE,
  type McpAppManifest,
  type McpAppResource,
} from '@bevel-software/platform-mcp-core';
import { mcpAppDir } from '../../assets.js';
import { logger } from '../../shared/logging.js';
import { OPEN_PAGE_TOOL } from './embed.tools.js';

const log = logger('embed');

/** The `ui://` URI of the one view this deployment serves. */
export const OPEN_PAGE_VIEW_URI = 'ui://hexis/page.html';

/** The view's file inside the packaged `mcp-app/` folder. */
const OPEN_PAGE_VIEW_FILE = 'page.html';

/**
 * The deployment's MCP Apps, built once per process: which tools carry a
 * view, and the views themselves with the sandbox metadata the host needs.
 *
 * Read once and cached — the file ships with the package and cannot change
 * under a running process, and `resources/read` is on the handshake path of
 * every connection that renders a page.
 */
export class McpAppService {
  private cached: Promise<McpAppManifest> | null = null;

  constructor(
    private readonly config: {
      /** The deployment's public frontend address — the ONE origin the view may frame. */
      readonly publicFrontendUrl: string;
    },
  ) {}

  /** Every app this deployment serves. Empty only if the packaged view is unreadable. */
  manifest(): Promise<McpAppManifest> {
    return (this.cached ??= this.build());
  }

  /** One view by URI, or null when this deployment serves none under it. */
  async resource(uri: string): Promise<McpAppResource | null> {
    const { resources } = await this.manifest();
    return resources.find((r) => r.uri === uri) ?? null;
  }

  private async build(): Promise<McpAppManifest> {
    let text: string;
    try {
      text = await readFile(path.join(mcpAppDir(), OPEN_PAGE_VIEW_FILE), 'utf8');
    } catch (err) {
      // No view, no app. Advertising a `resourceUri` whose resource cannot be
      // read would have a host preload a failure and show an empty frame
      // where the tool's text used to be; with no manifest `open_page` is an
      // ordinary tool answering ordinary text, which is the graceful shape.
      log.error(
        `could not read the MCP App view at ${path.join(mcpAppDir(), OPEN_PAGE_VIEW_FILE)}; ` +
          `open_page will carry no view: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { tools: {}, resources: [] };
    }
    const origin = originOf(this.config.publicFrontendUrl);
    return {
      tools: { [OPEN_PAGE_TOOL]: { resourceUri: OPEN_PAGE_VIEW_URI } },
      resources: [
        {
          uri: OPEN_PAGE_VIEW_URI,
          name: 'knowledge-base-page',
          title: 'Knowledge base page',
          description:
            "The knowledge-base page an agent opened, rendered by the app's own renderer for its type, " +
            'with Edit for a writer and Propose changes for everybody else.',
          mimeType: MCP_APP_MIME_TYPE,
          text,
          ui: {
            // EXACTLY this deployment's own public origin, and nothing else.
            // The view frames one address — the `/embed` page of the
            // deployment that served the view — so a wider list would buy
            // nothing and widen what a host's sandbox permits.
            csp: { frameDomains: origin ? [origin] : [] },
            // A STABLE sandbox domain: the host derives the view's opaque
            // origin from it, so a value that changed per render would throw
            // away the sandbox's storage on every call. Derived from the
            // view's identity, never from the request.
            domain: MCP_APP_SANDBOX_DOMAIN,
            // The framed page draws its own surface; a second border around
            // it reads as a box inside a box.
            prefersBorder: false,
          },
        },
      ],
    };
  }
}

/**
 * The sandbox domain the host gives this view. A constant: "stable" is the
 * whole requirement, and anything derived from a deployment, a user or a call
 * would be stable only by accident.
 */
export const MCP_APP_SANDBOX_DOMAIN = 'hexis-knowledge-page.mcp-app.invalid';

/**
 * `url`'s origin, or null when it does not parse. Only the origin: a
 * `frameDomains` entry is an origin, and a path or a credential in one is
 * either ignored or rejected by the host.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a public address can be framed inside a host's sandbox at all.
 *
 * Hosts run an MCP App's view in a sandboxed, https iframe, and no browser
 * will let an https document frame a plain-http one. So a deployment reached
 * over http has no embedded view — `open_page` still answers the page's text
 * and its address in the app, and says why there is nothing framed (see
 * Decision 8).
 */
export function isFrameableOrigin(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
