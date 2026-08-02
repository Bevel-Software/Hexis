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
 * Side and bottom padding — a TWO-STATE rule, not a ramp.
 *
 * This was `px-[clamp(40px,5%,64px)]`, on the theory that gutters should grow
 * with spare width rather than with a "sidebar hidden" flag. The theory was
 * fine; the arithmetic was not. Because `max-width` includes the padding
 * (border-box, above), a percentage gutter that resolves against the PANE eats
 * the LINE. At a 1440px window with the nav open the pane is ~1228px, 5% is
 * 61px, and the line came out at 880 − 122 = 758px — where the prototype gives
 * 800px. The ramp was permanently spending 42px of the default reading measure
 * to buy a smoother transition, and then collapsing the nav moved the line by
 * only 6px instead of the intended 48px. The one state anyone actually reads in
 * was the state it degraded.
 *
 * So it is the prototype's rule now, literally: 40px normally, 64px when the
 * nav is away (proto:137, proto:709). The caller passes which state it is in,
 * because only the caller knows — the Library reads its sidebar store, and
 * Knowledge reads its pane controller. That also keeps the original objection
 * satisfied: nothing here consults a global flag, so a narrow pane with the
 * nav open and a wide one with it closed are both described correctly.
 *
 * Under 900px the prototype collapses to a single column with 18px sides and
 * drops the bottom rhythm from 110px to 90px (proto:623-632) — that part is a
 * genuine viewport rule and stays a media query.
 */
const GUTTER_TAIL = 'pb-[110px] max-[900px]:px-[18px] max-[900px]:pb-[90px]';

/**
 * @param roomy the nav beside this column is hidden, so the space it gave up
 *              becomes margin on both sides rather than more line length.
 */
export const documentGutters = (roomy: boolean): string =>
  `${roomy ? 'px-[64px]' : 'px-[40px]'} ${GUTTER_TAIL}`;
