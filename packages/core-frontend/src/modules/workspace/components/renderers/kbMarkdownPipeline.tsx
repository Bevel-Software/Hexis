/**
 * The KB markdown pipeline: the plugin sets and the component overrides that
 * make markdown render the way this app renders knowledge — id-links that
 * navigate, `.md` path links, external links in a new tab, `<details>` blocks
 * as real disclosures, heading anchors, and mermaid fences as diagrams.
 *
 * Extracted from `KbMarkdownView` so a SECOND surface can render with the same
 * rules: the markdown diff viewer, which shows a document as red/green change
 * blocks and until now used bare react-markdown — no id-links, no `<details>`,
 * no mermaid, and no space-escaping in link destinations.
 *
 * Why an extraction and not "the diff viewer renders `<KbMarkdownView>`":
 * `KbMarkdownView` is a whole document view, and three of its properties are
 * actively wrong for a diff.
 *   - It runs `parseFrontmatter` on whatever string it is handed, and that
 *     regex matches ANY text starting with `---`. A diff is rendered in
 *     fragments split at arbitrary change boundaries, so a fragment that opens
 *     on a `---` thematic break would have everything up to the next `---`
 *     silently swallowed into a frontmatter panel. Content disappearing from a
 *     review surface is the worst bug available here.
 *   - It owns a scroller (`flex-1 overflow-auto`), which nested inside the
 *     change-request dialog's and the file-history panel's own scrollers gives
 *     a scroll trap.
 *   - It owns a `prose` scope, which the diff viewer also has — three nested
 *     typography scopes per fragment.
 * So the diff viewer keeps its own block grouping, frontmatter panel and
 * `prose` wrapper, and consumes only the parts below.
 *
 * NAVIGATION IS INJECTED, NEVER LOOKED UP. Nothing here calls a hook that
 * needs Git/Workspace context or a Router. That is load-bearing in two
 * directions: it keeps the diff viewer mountable from the enterprise `/embed*`
 * routes, which render outside those providers, and it keeps the existing
 * change-request and file-history tests — which render bare, with no Router —
 * passing without acquiring provider wrappers.
 */

import { Suspense, lazy, useMemo } from 'react';
import type { Options as MarkdownOptions } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import { CopyAnchorButton } from './CopyAnchorButton';

/**
 * Mermaid's eager core is ~151 KB gzip and is only needed by documents that
 * actually contain a ```mermaid fence — a small minority. Loading it lazily
 * keeps it out of the initial payload for every other page.
 */
const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
);

type PluginList = NonNullable<MarkdownOptions['remarkPlugins']>;

/**
 * Module-level and never rebuilt. react-markdown re-runs its whole pipeline
 * when the plugin array's IDENTITY changes, so an inline `[remarkGfm, …]`
 * literal in a render body re-parses on every render — which the diff viewer
 * was doing three times per change block.
 */
export const KB_REMARK_PLUGINS: PluginList = [remarkGfm, remarkFrontmatter];

/**
 * Document rendering. Order is load-bearing: rehype-raw parses inline HTML
 * (the `<details>` "Source of Information" blocks in KB nodes) into real
 * elements, rehype-sanitize runs AFTER so enabling HTML doesn't open an XSS
 * hole, and rehype-slug runs LAST so the heading ids it adds survive
 * sanitize's `user-content-` clobber prefix (which would break citation
 * anchors).
 *
 * raw and sanitize are a PAIR. Never enable the first without the second: this
 * pipeline renders other people's proposed content.
 */
export const KB_REHYPE_PLUGINS: PluginList = [rehypeRaw, rehypeSanitize, rehypeSlug];

/**
 * Diff rendering — the same pipeline WITHOUT rehype-slug.
 *
 * A diff is rendered as independent fragments, so rehype-slug runs once per
 * fragment and a heading that appears on both sides of a change (or in an
 * unchanged block and again in a changed one) yields duplicate DOM ids. Slugs
 * buy nothing here — a diff shows no copy-anchor buttons and nothing links
 * into it — so the correct trade is to leave them out rather than emit invalid
 * markup for a feature the surface does not offer.
 */
export const KB_DIFF_REHYPE_PLUGINS: PluginList = [rehypeRaw, rehypeSanitize];

export interface KbMarkdownComponentOptions {
  /**
   * Called with the raw href of an internal `.md` link. The caller resolves it
   * relative to the current node and decides how to open it. Omitted (e.g. the
   * file-history panel, where the "current node" is a past commit) → `.md`
   * links render as ordinary inert anchors.
   */
  onOpenFile?: (href: string) => void;
  /**
   * Called with the bare node `id` of an id-link (`[text](some-id)`). Omitted
   * (e.g. the embed, which has no in-app navigation) → id-links render as inert
   * text rather than falling through as relative-URL links.
   */
  onOpenNodeId?: (id: string) => void;
  /**
   * When provided, each heading gets a hover-revealed button copying
   * `headingLink(slug)`. Requires {@link KB_REHYPE_PLUGINS} (slug ids); pass it
   * only from document views, never from a diff.
   */
  headingLink?: (slug: string) => string;
  /**
   * What a mermaid fence that fails to parse should render.
   *
   * `'error'` (the default) shows mermaid's message — right for a document,
   * where a broken diagram is a defect the author wants to see.
   *
   * `'source'` falls back to the plain fenced code block. This is for diffs:
   * a diagram whose fence straddles a change boundary arrives at the renderer
   * truncated and CANNOT parse, so `'error'` would replace the red/green
   * source lines — the only useful thing in that block — with an error box, on
   * every edited diagram. Untouched diagrams sit inside a single unchanged
   * block, parse fine, and still render as diagrams.
   */
  onMermaidError?: 'error' | 'source';
}

/**
 * The component overrides for the KB pipeline. Memoised on the injected
 * callbacks, so a caller passing stable functions never rebuilds the map.
 */
export function useKbMarkdownComponents({
  onOpenFile,
  onOpenNodeId,
  headingLink,
  onMermaidError = 'error',
}: KbMarkdownComponentOptions) {
  return useMemo(() => {
    // One renderer for h1–h6: reads its level from the hast node's tagName,
    // re-attaches the rehype-slug `id`, and appends the copy-anchor button.
    const Heading = ({ node, id, children, className: cls, ...props }: {
      node?: { tagName?: string };
      id?: string;
      children?: React.ReactNode;
      className?: string;
    }) => {
      const Tag = (node?.tagName ?? 'h2') as keyof React.JSX.IntrinsicElements;
      return (
        <Tag id={id} className={`group/anchor ${cls ?? ''}`.trim()} {...props}>
          {children}
          {headingLink && id ? <CopyAnchorButton url={headingLink(id)} /> : null}
        </Tag>
      );
    };
    return {
      h1: Heading, h2: Heading, h3: Heading, h4: Heading, h5: Heading, h6: Heading,
      // `node` is destructured out and dropped in both overrides below.
      // react-markdown hands every component the hast node, and these spread
      // their remaining props straight onto a DOM element — so leaving it in
      // emitted a literal `node="[object Object]"` attribute on every rendered
      // link and code block, plus a React unknown-prop warning. (The heading
      // renderer above already dropped it; these two did not.)
      a({ node: _node, href, children, ...props }: {
        node?: unknown;
        href?: string;
        children?: React.ReactNode;
      }) {
        // id-link: `[text](some-id)` or `[text](some-id#heading)` — a bare node
        // id (the post-migration link form), optionally with a heading anchor
        // (the `cite_kb_node` citation form). Resolve via onOpenNodeId, which
        // splits off the heading. id grammar = lowercase alphanumeric + hyphens
        // + underscores (snake_case tool/skill ids resolve too); the `#…` tail
        // forbids `/` so a `.md` path link never matches. Keep in sync with
        // `NODE_ID_LINK_RE` in kb-routes (kept inline here to avoid pulling the
        // routing/hooks module into the embed bundle).
        if (href && /^[a-z0-9][a-z0-9_-]*(#[^/]+)?$/.test(href)) {
          // No resolver (e.g. the embed) → render inert, never a navigable
          // anchor, so a bare id can't fall through as a relative-URL link.
          if (!onOpenNodeId) return <span {...props}>{children}</span>;
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onOpenNodeId(href);
              }}
              className="cursor-pointer"
            >
              {children}
            </a>
          );
        }
        // Legacy/internal path link: a `.md` destination, optionally with a
        // heading anchor (`Node.md#goal`) — still used by frontmatter `nodeType`.
        // External (`http…`) and same-page (`#…`) links fall through to <a>.
        if (
          onOpenFile &&
          href && !href.startsWith('http') && !href.startsWith('#') && /\.md(#|$)/.test(href)
        ) {
          return (
            <a
              {...props}
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onOpenFile(href);
              }}
              className="cursor-pointer"
            >
              {children}
            </a>
          );
        }
        if (href && /^https?:\/\//i.test(href)) {
          return <a href={href} {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
        }
        return <a href={href} {...props}>{children}</a>;
      },
      pre({ node: _node, children, ...props }: { node?: unknown; children?: React.ReactNode }) {
        // Render a mermaid code block as a diagram.
        const child = Array.isArray(children) ? children[0] : children;
        if (
          child && typeof child === 'object' && 'props' in child &&
          typeof child.props.className === 'string' &&
          child.props.className.includes('language-mermaid')
        ) {
          const code = String(child.props.children).replace(/\n$/, '');
          const source = <pre {...props}>{children}</pre>;
          return (
            <Suspense fallback={source}>
              <MermaidDiagram
                code={code}
                errorFallback={onMermaidError === 'source' ? source : undefined}
              />
            </Suspense>
          );
        }
        return <pre {...props}>{children}</pre>;
      },
    };
  }, [onOpenFile, onOpenNodeId, headingLink, onMermaidError]);
}
