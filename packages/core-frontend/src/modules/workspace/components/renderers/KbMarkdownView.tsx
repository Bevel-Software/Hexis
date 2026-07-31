import { Suspense, lazy, useMemo, useState, type Ref } from 'react';
import { Link2, Check } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import { parseFrontmatter, labelFor } from '../../utils/frontmatter';
import { escapeSpacesInLinkDestinations } from '../../../../shared/markdown/Markdown';
/**
 * Mermaid's eager core is ~151 KB gzip and is only needed by documents that
 * actually contain a ```mermaid fence — a small minority. Loading it lazily
 * keeps it out of the initial payload for every other page.
 */
const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((m) => ({ default: m.MermaidDiagram })),
);

// A frontmatter value that is a single markdown link, e.g.
// `nodeType: [Process](../../NodeTypes/Process.md)` (parseFrontmatter strips
// the surrounding quotes). The destination may be angle-bracketed
// (`(<path with spaces.md>)`) so paths with spaces resolve. Anchored so only a
// whole-value link matches; everything else stays plain text.
const FRONTMATTER_LINK_RE = /^\[([^\]]+)\]\(<?([^)>]+)>?\)$/;

/**
 * Copy text to the clipboard. Prefers the async Clipboard API; falls back to a
 * hidden-textarea `execCommand('copy')` for contexts where the Clipboard API is
 * blocked by Permissions Policy (e.g. some embedded iframes).
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    let ta: HTMLTextAreaElement | null = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      // Always remove the textarea, even if select()/execCommand threw.
      if (ta?.parentNode) document.body.removeChild(ta);
    }
  }
}

/**
 * Hover-revealed "copy link to this heading" button — mirrors the FileViewer's
 * "copy link to this file" affordance (same `Link2` icon + 1.5s copied state),
 * but copies the heading's deep-link (URL + `#slug`) so a reader can cite a
 * specific section.
 */
function CopyAnchorButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        if (await copyToClipboard(url)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } else {
          console.error('Failed to copy heading link');
        }
      }}
      // `align-middle` keeps it on the heading baseline; hidden until the
      // heading is hovered (or the button is focused for keyboard users).
      className="ml-1.5 inline-flex align-middle p-0.5 rounded text-slate-400 no-underline opacity-0 transition-opacity hover:bg-slate-100 hover:text-slate-700 focus:opacity-100 group-hover/anchor:opacity-100"
      title={copied ? 'Link copied' : 'Copy link to this heading'}
      aria-label="Copy link to this heading"
    >
      {copied ? <Check size={13} /> : <Link2 size={13} />}
    </button>
  );
}

/**
 * Render a single frontmatter value. A value that is a markdown link (notably
 * `nodeType`) renders as a clickable link; everything else is plain text.
 * `onOpenFile` receives the raw href — the caller decides how to resolve and
 * open it (in-workspace navigation, or a new tab for the embed).
 */
function FrontmatterValue({
  value,
  onOpenFile,
}: {
  value: string;
  onOpenFile: (href: string) => void;
}) {
  const match = value.match(FRONTMATTER_LINK_RE);
  if (match) {
    const [, label, href] = match;
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          onOpenFile(href);
        }}
        className="text-bevel hover:text-bevel-deep hover:underline cursor-pointer"
      >
        {label}
      </a>
    );
  }
  return <>{value}</>;
}

function FrontmatterPanel({
  data,
  onOpenFile,
}: {
  data: Record<string, string | string[]>;
  onOpenFile: (href: string) => void;
}) {
  const entries = Object.entries(data).filter(([, v]) => {
    if (Array.isArray(v)) return v.length > 0;
    return v !== '';
  });
  if (entries.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-slate-300 bg-slate-100/70 divide-y divide-slate-200/60">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-3 px-3 py-2 text-xs">
          <span className="shrink-0 text-slate-600 w-28">{labelFor(key)}</span>
          <span className="text-slate-900 break-words">
            {Array.isArray(value) ? (
              value.join(', ')
            ) : (
              <FrontmatterValue value={value} onOpenFile={onOpenFile} />
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

interface KbMarkdownViewProps {
  /** Raw markdown (may include YAML frontmatter). */
  source: string;
  /**
   * Called with the raw href of an internal `.md` link (body or link-valued
   * frontmatter). The caller resolves it relative to the current node and
   * decides how to open it.
   */
  onOpenFile: (href: string) => void;
  /**
   * Called with the bare node `id` of an id-link (`[text](some-id)` — the
   * post-migration link form). The caller resolves the id to a node location and
   * navigates. When omitted, id-links render as inert text (e.g. the embed,
   * which has no in-app navigation).
   */
  onOpenNodeId?: (id: string) => void;
  /**
   * When provided, each heading gets a hover-revealed copy button that copies
   * `headingLink(slug)` — the heading's citation deep-link. `slug` is the
   * rehype-slug anchor id. Omit it (e.g. in the embed) to hide the buttons.
   */
  headingLink?: (slug: string) => string;
  /** Optional scroll container ref (used by the file viewer for deep-link scroll). */
  containerRef?: Ref<HTMLDivElement>;
  className?: string;
}

/**
 * Presentational KB markdown renderer — the read-mode view shared by the file
 * viewer's `MarkdownRenderer` and the Atlassian embed. Holds the canonical
 * plugin pipeline (GFM + frontmatter + raw/sanitize/slug + Mermaid) and the
 * frontmatter panel, with navigation injected via `onOpenFile` so it carries no
 * dependency on workspace routing or context.
 */
export function KbMarkdownView({ source, onOpenFile, onOpenNodeId, headingLink, containerRef, className }: KbMarkdownViewProps) {
  const { data: frontmatter, body } = useMemo(() => parseFrontmatter(source), [source]);
  // CommonMark rejects unescaped spaces in link destinations, so a KB link like
  // `[Foo](Some File.md)` would render as plain text. Wrap space-bearing
  // destinations in `<...>` so links to files with spaces resolve.
  const normalizedBody = useMemo(() => escapeSpacesInLinkDestinations(body), [body]);

  const components = useMemo(() => {
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
      a({ href, children, ...props }: { href?: string; children?: React.ReactNode }) {
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
        if (href && !href.startsWith('http') && !href.startsWith('#') && /\.md(#|$)/.test(href)) {
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
      pre({ children, ...props }: { children?: React.ReactNode }) {
        // Render a mermaid code block as a diagram.
        const child = Array.isArray(children) ? children[0] : children;
        if (
          child && typeof child === 'object' && 'props' in child &&
          typeof child.props.className === 'string' &&
          child.props.className.includes('language-mermaid')
        ) {
          const code = String(child.props.children).replace(/\n$/, '');
          return (
            <Suspense fallback={<pre {...props}>{children}</pre>}>
              <MermaidDiagram code={code} />
            </Suspense>
          );
        }
        return <pre {...props}>{children}</pre>;
      },
    };
  }, [onOpenFile, onOpenNodeId, headingLink]);

  return (
    <div className={`flex-1 overflow-auto ${className ?? ''}`} ref={containerRef}>
      <FrontmatterPanel data={frontmatter} onOpenFile={onOpenFile} />
      <div className="prose prose-sm max-w-none">
        <Markdown
          remarkPlugins={[remarkGfm, remarkFrontmatter]}
          // rehype-raw parses inline HTML (e.g. the `<details>` "Source of
          // Information" blocks in KB nodes) into real elements; rehype-sanitize
          // runs after so enabling HTML doesn't open an XSS hole. rehype-slug
          // runs LAST so the heading ids it adds survive sanitize's
          // `user-content-` clobber prefix (which would break citation anchors).
          rehypePlugins={[rehypeRaw, rehypeSanitize, rehypeSlug]}
          components={components}
        >
          {normalizedBody}
        </Markdown>
      </div>
    </div>
  );
}
