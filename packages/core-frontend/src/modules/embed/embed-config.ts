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
 *    deployment's origin and the token, and lends it the host's
 *    `ui/open-link`.
 *
 * This module is that handoff, in one place. The API client, the host
 * bridge and the view read it; nothing else needs to know which surface it
 * is on. Unconfigured, every answer is the SPA page's own, so the `/embed`
 * route behaves exactly as it always has.
 */

export interface EmbedRuntimeConfig {
  /**
   * The deployment's origin (`https://hexis.example`), when the embed runs
   * somewhere other than the deployment's own pages. Empty in the app, where
   * every address is relative to the page.
   */
  origin: string;
  /** The embed token, when it was handed over; null means "read the page URL". */
  token: string | null;
  /** How a link leaves the view, when the host lent a way; null means parent window or a new tab. */
  openLink: ((url: string) => void) | null;
}

const UNCONFIGURED: EmbedRuntimeConfig = { origin: '', token: null, openLink: null };

let current: EmbedRuntimeConfig = UNCONFIGURED;

/** Hand the embed its runtime: called once by {@link mountEmbed} before anything renders. */
export function configureEmbed(config: Partial<EmbedRuntimeConfig>): void {
  current = { ...current, ...config };
}

/** Back to the SPA page's own answers (tests). */
export function resetEmbedConfig(): void {
  current = UNCONFIGURED;
}

/**
 * The prefix every embed API path gets. The deployment's origin when the
 * embed runs elsewhere, and empty — a relative address, this page's own
 * origin — in the app.
 */
export function embedApiBase(): string {
  return current.origin;
}

/** The deployment's origin, for the absolute app addresses a host opens. */
export function embedOrigin(): string {
  return current.origin || window.location.origin;
}

/** The token this view was minted with: handed over, or read from the page URL. */
export function embedToken(): string {
  return current.token ?? new URLSearchParams(window.location.search).get('token') ?? '';
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
  /** The deployment's origin: where the API is and where app links point. */
  origin: string;
  /** The embed token `open_page` minted. */
  token: string;
  /** Opens an address in a new tab through the host (`ui/open-link`). */
  openLink?: (url: string) => void;
}

/**
 * The handoff the view left on the window, or null when this bundle was not
 * loaded by the view (a developer opening the file directly). Only a
 * well-formed one counts: an `http(s)` origin and a non-empty token, with the
 * origin reduced to exactly that — a path or a credential in it would make
 * every API address wrong.
 */
export function readEmbedHandoff(): EmbedHandoff | null {
  const raw = (window as unknown as Record<string, unknown>)[EMBED_HANDOFF_GLOBAL];
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as { origin?: unknown; token?: unknown; openLink?: unknown };
  if (typeof h.origin !== 'string' || !/^https?:\/\//i.test(h.origin)) return null;
  if (typeof h.token !== 'string' || h.token === '') return null;
  let origin: string;
  try {
    origin = new URL(h.origin).origin;
  } catch {
    return null;
  }
  return {
    origin,
    token: h.token,
    ...(typeof h.openLink === 'function' ? { openLink: h.openLink as (url: string) => void } : {}),
  };
}
