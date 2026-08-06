import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { Surface } from '../../../shared/components';

/**
 * The edged file pane — ONE frame for a document, wherever it renders.
 *
 * The Knowledge viewer and the skill page show the same kind of thing (a file,
 * in a box, named by the bar above it), and for a while they drew that box
 * twice: the skill page had the bordered card, Knowledge rendered the document
 * naked in its column. Two drawings of one thing drift — so, like `ROW_CLASS`
 * for the two sidebars, the frame is this one declaration and both surfaces
 * mount it.
 *
 * The skill page's variant won ("keep the one with the edges"): a `Surface`
 * card, a bar with the file's name in mono and the pane's actions beside it,
 * and the content on card padding below.
 */
export interface FilePaneCardProps {
  /** What the bar names — the file, e.g. `SKILL.md` or `How to get started.md`. */
  file: string;
  /** Right-hand side of the bar — Propose changes, Edit, whatever the page owns. */
  actions?: ReactNode;
  /** Sits between the bar and the body: the "your suggestions are inline" strip. */
  notice?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function FilePaneCard({ file, actions, notice, className, children }: FilePaneCardProps) {
  return (
    <Surface
      tone="surface"
      radius="lg"
      elevation="card"
      data-testid="file-pane-card"
      className={cn('overflow-hidden', className)}
    >
      <div className="flex min-h-11 items-center gap-3 border-b border-line px-3.5 py-2">
        <span className="mr-auto truncate font-mono text-meta text-ink-muted">{file}</span>
        {actions}
      </div>

      {notice}

      <div className="px-6 py-4">{children}</div>
    </Surface>
  );
}
