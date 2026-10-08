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
      /** The deployment's public frontend address — the ONE origin the view may reach. */
      readonly publicFrontendUrl: string;
      /** Where the view's file lives. The packaged `mcp-app/` folder unless a test says otherwise. */
      readonly viewDir?: string;
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
    const file = path.join(this.config.viewDir ?? mcpAppDir(), OPEN_PAGE_VIEW_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      // No view, no app. Advertising a `resourceUri` whose resource cannot be
      // read would have a host preload a failure and show an empty frame
      // where the tool's text used to be; with no manifest `open_page` is an
      // ordinary tool answering ordinary text, which is the graceful shape.
      log.error(
        `could not read the MCP App view at ${file}; ` +
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
            // EXACTLY this deployment's own public origin, and nothing else,
            // for the two things the view asks of the host's sandbox:
            // FETCHING the build manifest and the token-only embed API
            // (`connectDomains`), and LOADING the embed bundle's scripts and
            // stylesheets and the bytes the renderers draw
            // (`resourceDomains`). No `frameDomains`: the view frames
            // nothing. Claude's host drops that field and pins the sandbox's
            // `frame-src` to `'self'`, which turned a framed `/embed` into a
            // blank box — so the view loads the deployment's embed bundle
            // into its own document instead. A knowledge-base HTML page
            // still renders through the renderer's `srcdoc` sandbox, which
            // that policy allows.
            csp: {
              connectDomains: origin ? [origin] : [],
              resourceDomains: origin ? [origin] : [],
            },
            // Deliberately NO `domain`. The field asks the host for a
            // dedicated sandbox origin, and the specification leaves its
            // format and validation to each host ("servers MUST consult
            // host-specific documentation") — a value one host accepts,
            // another may reject, and a rejected resource is a view that
            // never renders. This view keeps no storage and has no OAuth
            // callback, so it needs no stable origin of its own; the host's
            // default sandbox is the right one.
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
 * `url`'s origin, or null when it does not parse. Only the origin: a
 * `connectDomains` / `resourceDomains` entry is an origin, and a path or a
 * credential in one is either ignored or rejected by the host.
 */
export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Whether a public address can be reached from inside a host's sandbox at all.
 *
 * Hosts run an MCP App's view in a sandboxed, https iframe, and no browser
 * will let an https document load scripts from, or fetch from, a plain-http
 * origin. So a deployment reached over http has no embedded view —
 * `open_page` still answers the page's text and its address in the app, and
 * says why there is nothing rendered (see Decision 8).
 */
export function isSandboxReachableOrigin(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
