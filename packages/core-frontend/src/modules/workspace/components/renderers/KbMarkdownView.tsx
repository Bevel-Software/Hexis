import { useMemo, type Ref } from 'react';
import Markdown from 'react-markdown';
import { parseFrontmatter, labelFor } from '../../utils/frontmatter';
import { escapeSpacesInLinkDestinations } from '../../../../shared/markdown/Markdown';
import {
  KB_REMARK_PLUGINS,
  KB_REHYPE_PLUGINS,
  useKbMarkdownComponents,
} from './kbMarkdownPipeline';

// A frontmatter value that is a single markdown link, e.g.
// `nodeType: [Process](../../NodeTypes/Process.md)` (parseFrontmatter strips
// the surrounding quotes). The destination may be angle-bracketed
// (`(<path with spaces.md>)`) so paths with spaces resolve. Anchored so only a
// whole-value link matches; everything else stays plain text.
const FRONTMATTER_LINK_RE = /^\[([^\]]+)\]\(<?([^)>]+)>?\)$/;

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
        className="text-accent hover:text-accent-hover hover:underline cursor-pointer"
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
    <div className="mb-4 rounded-lg border border-line-strong bg-sunken divide-y divide-line">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start gap-3 px-3 py-2 text-xs">
          <span className="shrink-0 text-ink-muted w-28">{labelFor(key)}</span>
          <span className="text-ink break-words">
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
  /** Optional container ref (used by the file viewer for deep-link scroll). */
  containerRef?: Ref<HTMLDivElement>;
  /**
   * Whether this view owns a scroller. `true` (the default) keeps the
   * `flex-1 overflow-auto` box every caller relied on before the Knowledge
   * document column existed — the Atlassian embed and the library's detail
   * dialog still do.
   *
   * The file viewer passes `false`: inside `KbDocumentShell` the COLUMN
   * scrolls, and a nested scroller there would break the measure (the
   * document would scroll inside a fixed-height well) and hide the shell's
   * scroll events from the file lock's activity listener.
   */
  scroll?: boolean;
  className?: string;
}

/**
 * Presentational KB markdown renderer — the read-mode view shared by the file
 * viewer's `MarkdownRenderer` and the Atlassian embed. Holds the canonical
 * plugin pipeline (GFM + frontmatter + raw/sanitize/slug + Mermaid) and the
 * frontmatter panel, with navigation injected via `onOpenFile` so it carries no
 * dependency on workspace routing or context.
 */
export function KbMarkdownView({ source, onOpenFile, onOpenNodeId, headingLink, containerRef, scroll = true, className }: KbMarkdownViewProps) {
  const { data: frontmatter, body } = useMemo(() => parseFrontmatter(source), [source]);
  // CommonMark rejects unescaped spaces in link destinations, so a KB link like
  // `[Foo](Some File.md)` would render as plain text. Wrap space-bearing
  // destinations in `<...>` so links to files with spaces resolve.
  const normalizedBody = useMemo(() => escapeSpacesInLinkDestinations(body), [body]);

  const components = useKbMarkdownComponents({ onOpenFile, onOpenNodeId, headingLink });

  return (
    <div
      className={`${scroll ? 'flex-1 overflow-auto' : 'min-w-0'} ${className ?? ''}`}
      ref={containerRef}
    >
      <FrontmatterPanel data={frontmatter} onOpenFile={onOpenFile} />
      <div className="prose prose-sm max-w-none">
        <Markdown
          remarkPlugins={KB_REMARK_PLUGINS}
          rehypePlugins={KB_REHYPE_PLUGINS}
          components={components}
        >
          {normalizedBody}
        </Markdown>
      </div>
    </div>
  );
}
