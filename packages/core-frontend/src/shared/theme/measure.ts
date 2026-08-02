/**
 * The document measure — ONE column width for the whole app.
 *
 * Knowledge and Skills are two views of one product, so a page must not
 * visibly change width when you switch between them. The prototype states this
 * as one rule (`skill-prototype-juan.html` `.wrap`, lines 132-138):
 *
 *     .wrap      { max-width: 880px; margin: 0 auto; padding: 34px 40px 110px }
 *     .wrap.wide { max-width: 980px }
 *
 * These constants are that rule, and they are the reason the two surfaces can
 * never drift: a change here moves both. They live in `shared/theme` rather
 * than beside either surface because the measure belongs to neither.
 *
 * `box-sizing: border-box` is on by default (Tailwind preflight), so the
 * max-width INCLUDES the gutters — widening the gutter shortens the line
 * rather than moving the column. That is deliberate: hiding the nav should buy
 * margin, not line length.
 *
 * TOP padding is deliberately NOT here. It is the one measure the two surfaces
 * do not share: Knowledge opens on a tab strip and starts high (12px), Skills
 * opens on a heading and keeps the roomier default (34px). See
 * `plans/05-knowledge-ui.md` §1. Set it at the call site.
 */

/** The default column: an 880px measure, centred. */
export const DOCUMENT_COLUMN = 'mx-auto w-full max-w-[880px]';

/** The opt-out, for a page that puts a second column (a rail) beside the article. */
export const DOCUMENT_COLUMN_WIDE = 'mx-auto w-full max-w-[980px]';

/**
 * Side and bottom padding.
 *
 * The sides GROW WITH SPARE WIDTH rather than with a global "sidebar hidden"
 * flag: with a chat pane open the document column can be narrow while the
 * explorer is open, and wide while it is closed, so the flag would be wrong in
 * both directions. A percentage padding resolves against the containing
 * block's inline size — the pane, not the window — which is exactly the
 * measurement we want, so `clamp()` expresses the whole rule without a
 * container query. Floor 40px (the prototype's default gutter), ceiling 64px
 * (its collapsed gutter, proto:709); the ramp spans a 800px-wide pane to a
 * 1280px one.
 *
 * Under 900px the prototype collapses to a single column with 18px sides and
 * drops the bottom rhythm from 110px to 90px (proto:623-632).
 */
export const DOCUMENT_GUTTERS =
  'px-[clamp(40px,5%,64px)] pb-[110px] max-[900px]:px-[18px] max-[900px]:pb-[90px]';
