import { useMemo } from 'react';
import { isExternalHref } from '../../../shared/markdown/hrefs';

export interface LinkOut {
  /** The link's visible text. */
  label: string;
  /** The raw href, exactly as written — the caller resolves it. */
  target: string;
}

/**
 * `[label](destination)`, with an optional angle-bracketed destination for
 * paths carrying spaces (`[Foo](<Some File.md>)`) — the same form
 * `escapeSpacesInLinkDestinations` produces.
 */
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(<?([^)>\s]+(?:\s[^)>]*)?)>?\)/g;

/**
 * The links this document MAKES — not backlinks.
 *
 * "Links out" is the prototype's own label and the honest reading of it:
 * outbound links are parseable from the content already on screen, whereas
 * backlinks would need an index that does not exist. If one ever lands, the
 * rail gains a second section; it does not change this one.
 *
 * The predicate is the markdown pipeline's `.md` rule — the internal-link
 * test the renderer uses for a page link where it has no link-target
 * resolver:
 *
 *     !isExternalHref(href) && !href.startsWith('#') && /\.md(#|$)/.test(href)
 *
 * (a scheme, not a prefix: `http-notes.md` is a page of the workspace)
 * so the rail lists the PAGES this one links to, and nothing that would take
 * the reader off the workspace. It is narrower than the file page's clicks on
 * purpose: with a resolver the pipeline also opens a link to an HTML page, a
 * PDF or an image in a new tab, and follows a bare node-id link, none of
 * which this rail lists — it is a list of pages, not of everything clickable.
 *
 * Non-markdown content yields `[]`, which the rail renders as no section
 * rather than an empty one.
 */
export function useLinksOut(path: string | null, content: string | null): LinkOut[] {
  return useMemo(() => {
    if (!path || content === null) return [];
    if (!/\.(md|markdown)$/i.test(path)) return [];

    const seen = new Set<string>();
    const out: LinkOut[] = [];
    for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
      const label = match[1].trim();
      const target = match[2].trim();
      if (isExternalHref(target) || target.startsWith('#')) continue;
      if (!/\.md(#|$)/.test(target)) continue;
      // One row per destination: a node linked three times is one place you
      // can go, not three.
      if (seen.has(target)) continue;
      seen.add(target);
      out.push({ label: label || target, target });
    }
    return out;
  }, [path, content]);
}
