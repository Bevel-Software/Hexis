/**
 * The header band — ONE row height for the two headers that sit side by side.
 *
 * Under the toolbar the app shows two rows at once: the sidebar's header row
 * on the left, and the page's title bar on the right. They are laid out by
 * different files (`layout/components/SidebarFrame` and each surface's page
 * header), and until this constant existed each of them arrived at its own
 * height by accident — the frame's column padding plus whatever its header
 * slot happened to be tall, against a page column's top padding plus an
 * `<h1>`'s line box. The two answers were about 20px apart, and the seam
 * between them is the first thing anyone sees below the toolbar.
 *
 * So the height is a TOKEN (`--spacing-header` in `./tokens.css`, which
 * Tailwind compiles into `.h-header`) and this is the one class string that
 * spends it. A header row wears `HEADER_BAND` and nothing else about its
 * height; a page that writes its own `h-[…]`, `py-…` or `mt-…` to make a
 * title bar "look right" has re-created the bug, which is why
 * `__tests__/header-band.test.ts` checks that every page title bar comes
 * through here.
 *
 * It lives in `shared/theme` rather than beside either header for the reason
 * `./measure.ts` does: the band belongs to neither of the two files that
 * render it, and a change to it has to move both or it is not a fix.
 *
 * `items-center` is what puts the two texts on one line. The band's contents
 * differ in size — a 13px nav row on one side, a 26px title on the other —
 * so centring them in an identical box is the only rule that survives either
 * one changing. `flex-none` keeps the band its own height inside the
 * sidebar's flex column, where a `flex-1` sibling would otherwise squeeze it.
 */
export const HEADER_BAND = 'flex h-header flex-none items-center';

/**
 * The air above the band, for every column that shows one.
 *
 * The band's TOP edge is the seam, not just its height, so a column that
 * starts its band lower than its neighbour breaks the alignment however well
 * the two heights agree. This was the actual bug: the Library's column opened
 * on 34px of padding ("Skills opens on a heading and keeps the roomier
 * default", `./measure.ts`) while Knowledge opened on 12px and the sidebar on
 * 16px — three numbers, three files, one seam.
 *
 * 12px is Knowledge's, kept: the toolbar already separates the column from
 * the window, so this only has to keep the band off the bar
 * (`.wrap.kb`, proto:695-699). The prototype's 34px `.wrap` padding is no
 * longer used by any column — under a toolbar the window edge it was written
 * for does not exist.
 */
export const HEADER_COLUMN_TOP = 'pt-3';

/**
 * The wrapper for a quiet `size="sm"` Button that LEADS a band — the `‹ Back`
 * link on the skill and tool pages.
 *
 * The negative margin is not a nudge. `Button`'s quiet `sm` size carries
 * `px-2` (`QUIET_SIZE.sm` in `shared/components/Button.tsx`), so a button
 * placed at the band's leading edge starts its TEXT 8px inside that edge,
 * while every other page's title starts on it — and a back link that hangs
 * 8px right of the heading below it is the same kind of not-quite-aligned
 * this whole band exists to remove. `-ml-2` cancels exactly that padding, so
 * the label's left edge is the column's left edge; the button's hover
 * background still covers its own padding, which is what the padding is for.
 *
 * It is a constant, and it says the number it is cancelling, because the
 * coupling runs the wrong way: this file cannot see `QUIET_SIZE`, so a change
 * to that padding silently moves the link. One place to fix beats two, and a
 * named constant is a thing a reader can grep for from `Button.tsx`.
 */
export const HEADER_BAND_LEAD = '-ml-2 flex-none';

/** The sidebar's header row, for the layout test that measures the seam. */
export const SIDEBAR_HEADER_TESTID = 'sidebar-header-row';

/** A page's title bar — the band on the other side of the seam. */
export const PAGE_HEADER_TESTID = 'page-header-row';
