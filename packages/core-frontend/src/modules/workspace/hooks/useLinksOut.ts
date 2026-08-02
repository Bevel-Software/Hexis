import { useMemo } from 'react';

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
 * The predicate is `KbMarkdownView.tsx:239`'s — the real internal-link test
 * the renderer itself uses to decide what opens in the workspace:
 *
 *     !href.startsWith('http') && !href.startsWith('#') && /\.md(#|$)/.test(href)
 *
 * so the rail lists exactly the links that are clickable as files, and
 * nothing that would take the reader off the workspace.
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
      if (target.startsWith('http') || target.startsWith('#')) continue;
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
