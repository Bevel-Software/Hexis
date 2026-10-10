/**
 * Where the embed is RUNNING, and what it was handed to run with.
 *
 * The embed's components run on two surfaces that answer three questions
 * differently — where the API is, which token this is, and how a link gets
 * out:
 *
 *  - The SPA's `/embed` page, inside a frame of a host that may frame it (an
 *    Atlassian issue panel, a developer's own tab). The token is in this
 *    page's URL, the API is this page's own origin, and a link out goes to
 *    the parent window, or to a new tab when there is no parent.
 *  - The MCP App view's sandbox in a chat. No frame to the deployment is
 *    allowed there — Claude pins the sandbox's `frame-src` to `'self'` and
 *    drops the `frameDomains` a view declares — so the view loads the
 *    deployment's embed bundle into ITS OWN document, tells it the
 *    deployment's address and the token, and lends it the host's
 *    `ui/open-link`.
 *
 * This module is that handoff, in one place. The API client, the host
 * bridge and the view read it; nothing else needs to know which surface it
 * is on. Unconfigured, every answer is the SPA page's own, so the `/embed`
 * route behaves exactly as it always has.
 */

export interface EmbedRuntimeConfig {
  /**
   * The deployment's public address — origin plus the path prefix it is
   * served under, if any (`https://hexis.example`,
   * `https://hexis.example/hexis`), with no trailing slash — when the embed
   * runs somewhere other than the deployment's own pages. Empty in the app,
   * where every address is relative to the page.
   */
  baseUrl: string;
  /** The embed token, when it was handed over; null means "read the page URL". */
  token: string | null;
  /** How a link leaves the view, when the host lent a way; null means parent window or a new tab. */
  openLink: ((url: string) => void) | null;
  /**
   * Who decides the view's height. `'host'`: the host gives the view a fixed
   * reading pane and the view scrolls inside it (the MCP App's pane). `'content'`:
   * the host sizes its frame to the content and the view reports its height
   * (the Atlassian issue panel, whose mint puts `sizing=content` on the
   * view's address). Null means "read the page URL", which defaults to the
   * host's pane.
   */
  sizing: EmbedSizing | null;
}

export type EmbedSizing = 'host' | 'content';

const UNCONFIGURED: EmbedRuntimeConfig = { baseUrl: '', token: null, openLink: null, sizing: null };

let current: EmbedRuntimeConfig = UNCONFIGURED;

/** Hand the embed its runtime: called by {@link mountEmbed} before anything renders. */
export function configureEmbed(config: Partial<EmbedRuntimeConfig>): void {
  current = { ...current, ...config };
}

/** Back to the SPA page's own answers — on unmount, and in tests. */
export function resetEmbedConfig(): void {
  current = UNCONFIGURED;
}

/**
 * Where this deployment is mounted, read from the page's own address when the
 * embed was not handed a base: the path before `/embed` (or `/embed/link`).
 * Empty for a deployment at the origin root; `/hexis` for one served under a
 * prefix, whose API and app links must keep it.
 */
function pagePrefix(): string {
  return window.location.pathname.replace(/\/embed(?:\/link)?\/?$/, '').replace(/\/+$/, '');
}

/**
 * The prefix every embed API path gets. The deployment's address when the
 * embed runs elsewhere; in the app, the deployment's mount prefix (usually
 * empty), so a relative address stays on this page's own origin and path.
 */
export function embedApiBase(): string {
  return current.baseUrl || pagePrefix();
}

/** The deployment's address, for the absolute app links a host opens. */
export function embedBaseUrl(): string {
  return current.baseUrl || `${window.location.origin}${pagePrefix()}`;
}

/** The token this view was minted with: handed over, or read from the page URL. */
export function embedToken(): string {
  return current.token ?? new URLSearchParams(window.location.search).get('token') ?? '';
}

/**
 * Who sizes the view: handed over, or read from the page URL
 * (`sizing=content`), else the host's fixed pane. See {@link EmbedRuntimeConfig.sizing}.
 */
export function embedSizing(): EmbedSizing {
  if (current.sizing) return current.sizing;
  return new URLSearchParams(window.location.search).get('sizing') === 'content' ? 'content' : 'host';
}

/** The host's way of opening a link, when it lent one. */
export function embedOpenLink(): ((url: string) => void) | null {
  return current.openLink;
}

/**
 * The global the MCP App view sets on its window before it loads the
 * deployment's embed bundle — the one contract between the view (a static
 * page shipped by core-backend) and the bundle (built by the deployment's
 * web app). The view writes it; {@link readEmbedHandoff} reads it.
 */
export const EMBED_HANDOFF_GLOBAL = '__HEXIS_EMBED__';

/** What the view hands the bundle. */
export interface EmbedHandoff {
  /** The deployment's address, prefix included: where the API is and where app links point. */
  baseUrl: string;
  /** The embed token `open_page` minted. */
  token: string;
  /** Opens an address in a new tab through the host (`ui/open-link`). */
  openLink?: (url: string) => void;
}

/**
 * The handoff the view left on the window, or null when this bundle was not
 * loaded by the view (a developer opening the file directly). Only a
 * well-formed one counts: an `http(s)` address and a non-empty token. The
 * address is kept to its origin and path — a query, a fragment or a trailing
 * slash in it would make every API address wrong — and the path stays,
 * because a deployment served under a prefix has its API under that prefix.
 */
export function readEmbedHandoff(): EmbedHandoff | null {
  const raw = (window as unknown as Record<string, unknown>)[EMBED_HANDOFF_GLOBAL];
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as { baseUrl?: unknown; token?: unknown; openLink?: unknown };
  if (typeof h.baseUrl !== 'string' || !/^https?:\/\//i.test(h.baseUrl)) return null;
  if (typeof h.token !== 'string' || h.token === '') return null;
  let baseUrl: string;
  try {
    const url = new URL(h.baseUrl);
    baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
  return {
    baseUrl,
    token: h.token,
    ...(typeof h.openLink === 'function' ? { openLink: h.openLink as (url: string) => void } : {}),
  };
}
