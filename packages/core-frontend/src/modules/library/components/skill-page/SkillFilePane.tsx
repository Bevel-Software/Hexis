import type { ReactNode, RefObject } from 'react';
import { Surface } from '../../../../shared/components';
import { KbMarkdownView } from '../../../workspace/components/renderers/KbMarkdownView';
import type { DiffLine } from '../../utils/diff';

interface SkillFilePaneProps {
  /** Repo-relative-to-the-skill file name, e.g. `SKILL.md`. */
  file: string;
  /** Raw file content, or null while it loads. */
  raw: string | null;
  /**
   * The caller's own pending suggestion rendered against `raw`, or null when
   * there is none. Present ⇒ the pane shows the diff INSTEAD of the file: you
   * are looking at what you proposed, not at what is there today.
   */
  suggestion: DiffLine[] | null;
  /** Right-hand side of the file bar — Edit, Propose changes, whatever the page owns. */
  actions?: ReactNode;
  /** Sits between the bar and the body: the "your suggestions are inline" strip. */
  notice?: ReactNode;
  /** Text selections inside this element are what `SuggestChange` listens for. */
  bodyRef?: RefObject<HTMLDivElement | null>;
  /** Follow a relative link out of rendered markdown. */
  onOpenLink?(href: string): void;
}

/**
 * One file, in a box — the prototype's `.filepane` (line 253): a bar naming the
 * file with its actions, and the file itself below.
 *
 * The box is the point. A skill is a FOLDER of files, and the tabs above only
 * make sense if the thing they switch has an edge you can see; without it the
 * body reads as page content that happens to change when you click a tab.
 */
export function SkillFilePane({
  file,
  raw,
  suggestion,
  actions,
  notice,
  bodyRef,
  onOpenLink,
}: SkillFilePaneProps) {
  return (
    <Surface
      tone="surface"
      radius="lg"
      elevation="card"
      className="mt-4 overflow-hidden"
    >
      <div className="flex min-h-11 items-center gap-3 border-b border-line px-3.5 py-2">
        <span className="mr-auto truncate font-mono text-meta text-ink-muted">{file}</span>
        {actions}
      </div>

      {notice}

      <div ref={bodyRef} className="px-6 py-4">
        {raw === null ? (
          <p className="py-4 text-center text-detail text-ink-faint">Loading…</p>
        ) : suggestion ? (
          <SuggestionDiff lines={suggestion} />
        ) : file.endsWith('.md') ? (
          <KbMarkdownView source={raw} onOpenFile={(href) => onOpenLink?.(href)} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
            {raw}
          </pre>
        )}
      </div>
    </Surface>
  );
}

/**
 * Removed and added lines as `<del>` / `<ins>`, not coloured `<div>`s: what is
 * on screen is a claim about what changed, and the elements that MEAN that are
 * the ones a screen reader announces as such. The colours come from `.lib-sug`
 * in `library.css` — the same rule the compare view's marks use, so an inline
 * suggestion and a reviewed one never drift apart visually.
 */
function SuggestionDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="lib-sug whitespace-pre-wrap break-words font-mono text-detail leading-relaxed text-ink-muted">
      {lines.map((l, i) =>
        l.kind === 'same' ? (
          <div key={i}>{l.text || ' '}</div>
        ) : l.kind === 'removed' ? (
          <del key={i} className="block">
            {l.text || ' '}
          </del>
        ) : (
          <ins key={i} className="block">
            {l.text || ' '}
          </ins>
        ),
      )}
    </pre>
  );
}
