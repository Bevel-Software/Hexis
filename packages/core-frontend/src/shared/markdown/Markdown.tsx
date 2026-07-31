import { memo, useMemo, type ComponentProps } from 'react';
import Md from 'react-markdown';
import remarkGfm from 'remark-gfm';

type RemarkPlugins = ComponentProps<typeof Md>['remarkPlugins'];
type MdComponents = ComponentProps<typeof Md>['components'];

// Module-level constant so the plugins prop identity is stable across renders.
// react-markdown reuses its internal pipeline only when the plugins array is
// referentially equal — a fresh array per render forces a full re-parse.
const DEFAULT_PLUGINS: RemarkPlugins = [remarkGfm];

// CommonMark rejects unescaped spaces in link destinations, which means
// `[Foo](knowledge-base/0. Current Truth/x.md)` parses as plain text — the
// agent emits paths like this routinely (KB filenames contain spaces). Wrap
// any unwrapped destination that contains a space in `<...>`, which CommonMark
// accepts. Skips destinations that already start with `<` so we don't
// double-wrap.
const LINK_WITH_SPACE_RE = /(\[[^\]\n]*\])\(([^<\s)][^)\n]*)\)/g;

export function escapeSpacesInLinkDestinations(markdown: string): string {
  return markdown.replace(LINK_WITH_SPACE_RE, (match, label, destination) => {
    if (!destination.includes(' ')) return match;
    return `${label}(<${destination}>)`;
  });
}

interface Props {
  children: string;
  extraPlugins?: RemarkPlugins;
  /** Component overrides merged on top of react-markdown defaults. */
  components?: MdComponents;
  className?: string;
}

function MarkdownImpl({ children, extraPlugins, components, className }: Props) {
  // Memoize the merged plugins array so its identity is stable across renders
  // when extraPlugins is referentially stable. A fresh array each render forces
  // react-markdown to rebuild its pipeline and re-parse the entire document.
  const plugins = useMemo<RemarkPlugins>(
    () => (extraPlugins ? [remarkGfm, ...extraPlugins] : DEFAULT_PLUGINS),
    [extraPlugins],
  );

  const normalized = useMemo(
    () => escapeSpacesInLinkDestinations(children),
    [children],
  );

  return (
    <div className={`prose prose-sm max-w-none ${className ?? ''}`}>
      <Md remarkPlugins={plugins} components={components}>
        {normalized}
      </Md>
    </div>
  );
}

// Default shallow memo: skip re-render when (children, extraPlugins, components,
// className) are referentially equal. Callers must keep `components` stable
// (typically via useMemo); see AssistantTurn.
export const Markdown = memo(MarkdownImpl);
