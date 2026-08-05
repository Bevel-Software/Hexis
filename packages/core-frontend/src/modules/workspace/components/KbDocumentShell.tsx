import type { ReactNode, Ref } from 'react';
import { cn } from '../../../lib/utils';
import {
  DOCUMENT_COLUMN,
  DOCUMENT_COLUMN_WIDE,
  documentGutters,
} from '../../../shared/theme/measure';

/**
 * The Knowledge surface's document column — the prototype's `.wrap.kb`.
 *
 * It holds the measure, the gutters, and the single explicit answer to "who
 * scrolls". Before this existed, the viewer pane was `overflow-hidden` and
 * every renderer owned its own scroller, so a 2000px-wide window gave a
 * markdown document a 2000px line. The measure fixes that — but only for the
 * renderers that produce a document; see `variant`.
 *
 * The tab strip mounts INSIDE it, not above it. That is the prototype's own
 * rule (proto:700-705): one column holds tabs, title and text at the same
 * width, so they share an edge and the page reads as a single centred block.
 */
export interface KbDocumentShellProps {
  /** Widens the column and opens the second track for the rail. */
  rail?: ReactNode;
  /**
   * 'prose'      — the shell scrolls, holds the 880/980 measure and the gutters.
   *                For renderers that produce a document: markdown, text, docx,
   *                the HTML source view.
   * 'full-bleed' — the shell yields: no measure, no bottom rhythm, and it gives
   *                its child a DEFINITE height instead of scrolling it. For
   *                renderers that are already a fixed-height viewport of their
   *                own: pdf (an `h-full` iframe that collapses to 0 in an
   *                auto-height column), image, csv, xlsx, the html sandbox
   *                iframe, and the tool form (whose `w-72` aside does not fit
   *                inside 880px minus gutters).
   *
   * The caller picks from the extension, via `getRendererLayout` in
   * `renderers/index.ts` — the same map `getFileRenderer` uses. Getting this
   * wrong does not type-error; it renders a zero-height PDF.
   */
  variant?: 'prose' | 'full-bleed';
  /**
   * The file tree beside this column is hidden, so the space it gave up should
   * become margin on both sides rather than more line length (proto:709). The
   * caller owns this because only it knows: the pane controller, not a global
   * flag. Defaults to false — the nav is usually there.
   */
  roomy?: boolean;
  /**
   * Lands on the element that ACTUALLY scrolls. `FileViewer` passes
   * `editorContainerRef` here: a capture-phase scroll listener is bound to it
   * and is the only thing resetting the file lock's idle-release timer for a
   * user who is reading rather than typing. Scroll events do not bubble, so a
   * ref on an element nested *inside* the scroller never fires — which is why
   * the ref lands on this component's outermost box in BOTH variants, and why
   * that box carries `overflow-auto` in both. In `full-bleed` the child is
   * exactly `h-full`, so nothing overflows and no scrollbar appears; the
   * listener still catches the renderer's own scroller during capture.
   */
  scrollRef?: Ref<HTMLDivElement>;
  /**
   * The id of the heading that names `rail`, for the `<aside>`'s
   * `aria-labelledby`. The shell cannot read a name out of a `ReactNode`, and
   * an unnamed complementary landmark is one a screen reader can only announce
   * as "complementary" — so the rail names itself and hands the id over.
   */
  railLabelledBy?: string;
  children: ReactNode;
}

export function KbDocumentShell({
  rail,
  variant = 'prose',
  roomy = false,
  scrollRef,
  railLabelledBy,
  children,
}: KbDocumentShellProps) {
  return (
    <div
      ref={scrollRef}
      data-testid="kb-document-shell"
      data-variant={variant}
      className={cn(
        'relative min-h-0 flex-1 overflow-auto',
        variant === 'full-bleed' && 'flex flex-col',
      )}
    >
      {variant === 'full-bleed' ? (
        // A definite height, not a scroll. `h-full` resolves against this
        // component's own (flex-sized, definite) height, so an `h-full` iframe
        // inside gets real pixels instead of collapsing to zero.
        //
        // The rail still opens here — the facts it carries (where the file is,
        // who last touched it, who can read it) are as true of a PDF as of a
        // paragraph. It takes a fixed column beside the viewport rather than
        // widening a measure there is none of, and scrolls on its own so a
        // long link list cannot stretch the iframe.
        <div className="flex h-full min-h-0 w-full">
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">{children}</div>
          {rail && (
            <aside
              aria-labelledby={railLabelledBy}
              className="w-[296px] flex-none overflow-y-auto py-4 pr-4"
            >
              {rail}
            </aside>
          )}
        </div>
      ) : rail ? (
        // The wide measure: `minmax(0,620px)` + a 296px rail with a 44px gap
        // (proto:344). The article track is minmax-from-zero so the rail never
        // pushes the column into a horizontal scroll — at 980px minus gutters
        // the article simply takes what is left. Under 900px the rail stacks
        // below the article rather than beside it (proto:633).
        <div
          className={cn(
            DOCUMENT_COLUMN_WIDE,
            documentGutters(roomy),
            'grid grid-cols-1 items-start gap-11 pt-3',
            'max-[900px]:gap-[26px] min-[901px]:grid-cols-[minmax(0,620px)_296px]',
          )}
        >
          <article className="min-w-0">{children}</article>
          <aside aria-labelledby={railLabelledBy} className="min-w-0">
            {rail}
          </aside>
        </div>
      ) : (
        // `pt-3` is 12px — Knowledge's own top padding, NOT the app-wide 34px.
        // The top bar already separates the column from the window, so the
        // page's own padding only has to keep the tabs off the bar
        // (`.wrap.kb`, proto:695-699). Do not "fix" this to 34px.
        <div className={cn(DOCUMENT_COLUMN, documentGutters(roomy), 'pt-3')}>{children}</div>
      )}
    </div>
  );
}
