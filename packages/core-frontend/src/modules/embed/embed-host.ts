import { kbFileUrl, resolveKbHref } from '../workspace/routing/kb-routes';
import { isOpenableExternalHref, normalizeHref } from '../../shared/markdown/hrefs';
import { embedBaseUrl, embedOpenLink } from './embed-config';

/**
 * What an expired, missing or rejected embed token shows. One sentence, no
 * content, and the one thing the reader can act on: ask again.
 *
 * Exported because it is the acceptance criterion in words — the tests assert
 * on this exact text, and the view must have no second way to say it.
 */
export const EMBED_EXPIRED =
  'This view has expired. Ask the agent to open the page again.';

/** The message the embed page sends its host to have a link opened. */
export const EMBED_OPEN_MESSAGE = 'bevel-embed-open';
/**
 * What the embed posts to its host when its content height changes, so a
 * host that sizes its frame to the content (the Atlassian issue panel does)
 * can follow. `{ type, height }`, height in CSS pixels.
 */
export const EMBED_HEIGHT_MESSAGE = 'bevel-embed-height';

/**
 * The host's origin, from the referrer — used as the explicit `postMessage`
 * target so nothing is broadcast to `'*'` when we know better.
 *
 * Null when the referrer is stripped or blocked, which is the common case in
 * a sandboxed iframe; the relay then falls back to `'*'`. That is acceptable
 * and not a leak: the payload is a URL to open, the host re-validates it
 * before acting, and the alternative is a dead link.
 */
export function hostOrigin(): string | null {
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

/**
 * Open a destination OUT of the embed — always in a new tab, never in this
 * frame.
 *
 * Inside a host's sandbox `window.open` and `target=_blank` are blocked (no
 * `allow-popups`), so the embed asks the host to open it. Running inside the
 * MCP App view's own document, the view lent it the extension's
 * `ui/open-link` (see `embed-config`); framed by an Atlassian panel, it posts
 * to the parent, which answers with Forge's `router.open`. Standalone — a
 * developer opening `/embed?token=…` directly — falls back to `window.open`.
 *
 * `href` is resolved first, against `basePath` (the file the link sits in)
 * and with `kb`'s naming, so a relative knowledge-base link becomes the app's
 * own absolute address rather than a path only the embed could interpret. An
 * external address is handed over as written.
 *
 * The embed NEVER navigates itself: it is one page deep by decision, and a
 * token is minted for one file — navigating would show a page nothing
 * authorised inside a frame the reader has no way back out of.
 */
export function openThroughHost(
  href: string,
  basePath: string,
  kb: { kbDirName: string; branch: string } | null,
): void {
  const url = resolveToAppUrl(href, basePath, kb);
  if (url === null) return;
  const lent = embedOpenLink();
  if (lent) {
    lent(url);
    return;
  }
  if (window.parent !== window) {
    window.parent.postMessage({ type: EMBED_OPEN_MESSAGE, url }, hostOrigin() ?? '*');
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * `href` as an absolute address a host can open: a knowledge-base link
 * becomes this deployment's `/workspace/<branch>/<path>` URL, an external one
 * is passed through, and anything the link grammar refuses is null.
 *
 * Exported for direct testing — the resolution is the part with rules, and
 * `postMessage` is not testable without a host.
 */
export function resolveToAppUrl(
  href: string,
  basePath: string,
  kb: { kbDirName: string; branch: string } | null,
): string | null {
  if (!kb) {
    // An address the embed built itself — the account-link page, a change
    // request, the app's own page — not one read out of a knowledge-base
    // page. A root-relative path is this deployment's; anything absolute
    // still has to pass the scheme allowlist below, for the same reason.
    const url = normalizeHref(href);
    if (url.startsWith('/') && !url.startsWith('//')) return `${embedBaseUrl()}${url}`;
    // A protocol-relative `//host/path` names another origin without saying
    // so; the embed never builds one, so it is refused rather than relayed.
    return !url.startsWith('//') && isOpenableExternalHref(url) ? url : null;
  }
  const target = resolveKbHref(href, { basePath, kbDirName: kb.kbDirName });
  if (target === null) return null;
  /**
   * An external destination goes to the host — but only one from the SCHEME
   * ALLOWLIST, and in its normalised spelling.
   *
   * This is load-bearing rather than belt-and-braces. The embed asks its host
   * to open whatever it hands over, and a host obliges: `javascript:alert(1)`
   * is a destination the link grammar happily calls "external", and relaying
   * it would be asking the host to run it. The app's own link handler
   * (`openExternalHref`) applies exactly this allowlist for exactly this
   * reason; the embed's has to apply it too, because the embed's links come
   * from a knowledge-base page an agent may have written.
   */
  if (target.kind === 'external') {
    return isOpenableExternalHref(href) ? normalizeHref(href) : null;
  }
  if (target.kind !== 'workspace') return null;
  // A link that named its own branch keeps it; everything else opens on the
  // branch the embed rendered, which is the default branch.
  const branch = target.branch ?? kb.branch;
  return `${embedBaseUrl()}${kbFileUrl(branch, target.path)}${target.hash}`;
}
