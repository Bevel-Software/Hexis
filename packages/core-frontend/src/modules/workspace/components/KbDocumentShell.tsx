import type { ReactNode, Ref } from 'react';
import { cn } from '../../../lib/utils';
import {
  DOCUMENT_COLUMN,
  DOCUMENT_COLUMN_WIDE,
  documentGutters,
  documentSideGutters,
} from '../../../shared/theme/measure';
import { HEADER_COLUMN_TOP } from '../../../shared/theme/header';

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
 * It mounts inside it BELOW the title bar, though — see `header`.
 */
export interface KbDocumentShellProps {
  /**
   * Widens the column and opens the second track for the rail. Read by the
   * 'prose' and 'full-bleed' variants only: 'panel' is the document column
   * standing in for the document, and the pages that use it (history,
   * comparison) withdraw the rail with the document it describes.
   */
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
   * 'panel'      — the reading view's COLUMN with full-bleed's HEIGHT: the same
   *                880px measure and the same side margins as 'prose', and a
   *                definite height so a panel that scrolls inside itself gets
   *                real pixels. For the file page's history and comparison
   *                modes, which are viewports the way a PDF is but which take
   *                the DOCUMENT's place and must not move it: switching to
   *                history changes what is in the column, not where the column
   *                is. They used to take 'full-bleed', which gave the title
   *                nothing to stand on at the pane's left edge and started the
   *                timeline flush against it.
   *
   * The caller picks from the extension, via `getRendererLayout` in
   * `renderers/index.ts` — the same map `getFileRenderer` uses. Getting this
   * wrong does not type-error; it renders a zero-height PDF.
   */
  variant?: 'prose' | 'full-bleed' | 'panel';
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
   * the ref lands on this component's outermost box in EVERY variant, and why
   * that box carries `overflow-auto` in all of them. In `full-bleed` and
   * `panel` the child is exactly `h-full`, so nothing overflows and no
   * scrollbar appears; the listener still catches the renderer's own scroller
   * during capture.
   */
  scrollRef?: Ref<HTMLDivElement>;
  /**
   * The id of the heading that names `rail`, for the `<aside>`'s
   * `aria-labelledby`. The shell cannot read a name out of a `ReactNode`, and
   * an unnamed complementary landmark is one a screen reader can only announce
   * as "complementary" — so the rail names itself and hands the id over.
   */
  railLabelledBy?: string;
  /**
   * The page's title bar — and the FIRST row of this column, in every
   * variant, on `HEADER_COLUMN_TOP`.
   *
   * A SLOT rather than the caller's first child, for the same reason
   * `SidebarFrame` owns the row on the other side of the seam: the band's top
   * edge is the seam, so "the title bar opens the column" is a rule the frame
   * has to hold, not a JSX order a caller has to remember. It was a JSX order
   * once, and `FileViewer` put `<EditorTabs />` above it — a 36px tab strip
   * plus its 18px gap, so the file page's title bar rendered 54px below the
   * sidebar header row it was supposed to line up with, at every width,
   * whatever the two heights agreed on. Staging caught that; nothing in the
   * suite did, because no test rendered the header in its real page.
   *
   * Passing nothing is a page with no title bar (the change-request and
   * review surfaces): the column simply opens on its children.
   */
  header?: ReactNode;
  children: ReactNode;
}

export function KbDocumentShell({
  rail,
  variant = 'prose',
  roomy = false,
  scrollRef,
  railLabelledBy,
  header,
  children,
}: KbDocumentShellProps) {
  return (
    <div
      ref={scrollRef}
      data-testid="kb-document-shell"
      data-variant={variant}
      className={cn(
        'relative min-h-0 flex-1 overflow-auto',
        variant !== 'prose' && 'flex flex-col',
      )}
    >
      {variant === 'panel' ? (
        // The reading view's frame, to the class: `DOCUMENT_COLUMN` and
        // `documentSideGutters` are the same two calls the prose branch below
        // makes, from the same `roomy` flag, so the title, the tab strip and
        // whatever panel follows them all open on the margin the document
        // opens on. The tests compare the two frames rather than restating
        // either — `__tests__/KbDocumentShell.test.tsx` on the component and
        // `__tests__/FileViewer.test.tsx` on the real page going into history
        // and coming back.
        //
        // What differs is the height and the bottom: `h-full min-h-0 flex-col`
        // hands the panel a definite box to scroll inside, exactly as
        // full-bleed does for a PDF, and the 110px rhythm under a document is
        // left off a column that ends where the pane does.
        <div
          className={cn(
            DOCUMENT_COLUMN,
            documentSideGutters(roomy),
            HEADER_COLUMN_TOP,
            'flex h-full min-h-0 flex-col',
          )}
        >
          {header}
          {children}
        </div>
      ) : variant === 'full-bleed' ? (
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
          {/* `HEADER_COLUMN_TOP` here too. Full-bleed gives up the measure and
              the gutters, but NOT the seam: this column used to open straight
              onto its renderer, so a PDF's title bar sat 12px HIGHER than the
              sidebar's header row — the prose column's bug in the opposite
              direction. The offset rides the column the band is already in
              rather than a wrapper of its own, so the chain of definite
              heights above is untouched; border-box means the renderer below
              simply gets 12px less of it. */}
          <div
            className={cn('flex h-full min-h-0 min-w-0 flex-1 flex-col', HEADER_COLUMN_TOP)}
          >
            {header}
            {children}
          </div>
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
            'grid grid-cols-1 items-start gap-11',
            HEADER_COLUMN_TOP,
            'max-[900px]:gap-[26px] min-[901px]:grid-cols-[minmax(0,620px)_296px]',
          )}
        >
          <article className="min-w-0">
            {header}
            {children}
          </article>
          <aside aria-labelledby={railLabelledBy} className="min-w-0">
            {rail}
          </aside>
        </div>
      ) : (
        // `HEADER_COLUMN_TOP` is 12px — the offset every column that opens
        // on a header band shares, Knowledge's own value promoted to a token.
        // The top bar already separates the column from the window, so the
        // page's own padding only has to keep the tabs off the bar
        // (`.wrap.kb`, proto:695-699). The Library opened on 34px until
        // this ticket, and 34 against 12 is what put the two surfaces' title
        // bars on different lines. Do not "fix" this back to 34px.
        <div className={cn(DOCUMENT_COLUMN, documentGutters(roomy), HEADER_COLUMN_TOP)}>
          {header}
          {children}
        </div>
      )}
    </div>
  );
}
