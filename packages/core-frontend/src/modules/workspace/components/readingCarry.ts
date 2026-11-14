/**
 * Carrying a reader's place across the full-screen switch.
 *
 * The read pane leaving the shell's flow collapses the shell's scroll (the
 * pane takes its scrollTop with it), so the position is carried by hand:
 * into the pane's own scroller on the way in, back into the shell's on the
 * way out. Measured against the document's BODY, not the pane: between the
 * two views the pane gains padding and the card loses its bar, so the pane's
 * top is a different distance above the text in each, and a carry against
 * it lands the reader that many pixels off. And it only holds when the text
 * is laid out at the SAME width in both views ({@link readingWidthOf}): a
 * column that wraps differently puts every line below the first at a
 * different height, and no pixel offset survives that — Section 24 came
 * back as Section 30.
 *
 * Pure functions over live elements, so the real-browser suite can load them
 * into a page as they are (`browser/full-screen-reading-width.browser.ts`):
 * the unit suite's happy-dom lays nothing out, and this is layout.
 */

/**
 * The prose document's body inside the read pane — what the switch measures
 * the reader's place against. Null for a full-bleed file, which has no card
 * and scrolls inside its own renderer.
 */
export function readingAnchorIn(pane: HTMLElement | null): HTMLElement | null {
  // The body of the pane's own card (its direct child), found by the body's
  // own marker: a test id is the tests' to rename, and a selector hung on it
  // would stop the carry silently the day one is.
  return pane?.querySelector<HTMLElement>(':scope > * > [data-file-pane-body]') ?? null;
}

/**
 * How far into the document the reader is: the scroller's top edge below
 * the body's top, in pixels (negative while the body's top is still below
 * the edge).
 */
export function readingOffset(scroller: Element, anchor: Element): number {
  return scroller.getBoundingClientRect().top - anchor.getBoundingClientRect().top;
}

/**
 * Scroll `scroller` so its top edge sits `offset` px below the body's top
 * again — a delta on whatever the scroller holds now, so it is right whether
 * the scroller kept its place or collapsed to the top.
 */
export function carryReadingOffset(scroller: HTMLElement, anchor: Element, offset: number): void {
  scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + offset;
}

/**
 * The width the page laid the document's card out at, to hold while filling
 * the window so every line wraps where it did. Null when there is none to
 * hold (no card, or one not laid out).
 */
export function readingWidthOf(anchor: Element): number | null {
  const card = anchor.parentElement;
  return card ? card.getBoundingClientRect().width || null : null;
}
