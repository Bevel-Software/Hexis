import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';

/**
 * How much of the name survives when something else is sharing its line.
 *
 * The bug this exists for: a card's header row put a `truncate` name next to
 * `shrink-0` badges, so the badges took whatever width they wanted and the
 * name paid for all of it — a 236px card showed "di…" beside four pills that
 * each said less than the word they had crowded out.
 *
 * `ch` rather than a pixel count, because the thing being protected is a
 * number of CHARACTERS: the floor has to mean the same amount of readable
 * name whatever size the row is set in, and a card's name (`lede`) and a page
 * title (`display`) are not the same size. 12 is the ticket's number. It does
 * not promise a whole name — no floor can, against a name of any length — it
 * promises enough of one to tell the cards in a grid apart, which is the
 * question a grid is actually scanned for.
 *
 * Exported so the tests can name it rather than re-typing the class.
 */
export const NAME_MIN_WIDTH = 'min-w-[12ch]';

export interface NameWithBadgesProps {
  /**
   * The full name, as text. It is always in the DOM in full — the truncation
   * is `text-overflow`, so a screen reader reads the whole thing — and it is
   * repeated in `title` for the sighted reader who cannot.
   */
  name: string;
  /**
   * The chips that qualify the name — `Owner`, `Linked`, `MCP server`.
   * ABSENT, not an empty fragment, when there are none: whether anything is
   * competing with the name for the row is what decides whether the name is
   * given a floor, and `<></>` cannot be told apart from three pills.
   */
  badges?: ReactNode;
  /**
   * A mark that belongs to the name — a tool's logo.
   *
   * It does NOT earn the name a floor, and the distinction is the one this
   * component got wrong first time round. A badge can be moved: when the
   * floor and the badges stop fitting, the badges take a second line and give
   * the whole row back to the name. A mark cannot — it is fixed width, it sits
   * on the name's own line, and no floor can conjure the space it is holding.
   * A floor granted for a mark is therefore a floor with nothing to take the
   * space back FROM, which is an overflow with extra steps.
   */
  leading?: ReactNode;
  /**
   * Whether the badges may take a second line. True everywhere the row is
   * allowed to grow, which is every list and every card.
   *
   * `false` is for a row whose height is a contract the row does not own —
   * the tool page's title bar is `HEADER_BAND`, exactly as tall as the
   * sidebar's header row beside it, and a second line there does not make the
   * band taller, it hangs out of the bottom of it. Such a caller owes the row
   * an `overflow-hidden`: with nowhere to wrap to, the only other way out is
   * across whatever is beside it.
   */
  wrap?: boolean;
  /** Typography for the name itself — the caller's `text-lede`/`text-display`. */
  nameClassName?: string;
  /**
   * The gap between everything on the row. A prop because the page header
   * sets its band on `gap-4` and a card sets its row on `gap-2`, and the gap
   * between a name and its badges is not a different measurement from the gap
   * between a logo and its name.
   */
  gap?: string;
  className?: string;
  /**
   * What the name element is. A page's title is an `h1`; a card's and a row's
   * name is a `span`, because the card is already a button with an accessible
   * name and a heading inside it would announce a second one.
   */
  as?: 'span' | 'h1';
}

/**
 * A name, and the things that share its line, laid out so the NAME wins.
 *
 * Two rules, and the second is the one that was missing:
 *
 *  1. The name truncates with an ellipsis and carries its full self in
 *     `title` — which the card already did.
 *  2. Below a floor it stops giving way and the badges WRAP UNDER IT instead
 *     — which nothing did, and which is why a narrow card said "di…".
 *
 * The mechanics, because they are not guessable from the class list:
 *
 * The row is `flex-wrap`, and its children are FLAT — mark, name, badge
 * group, all siblings. The flatness is load-bearing. Wrapping the mark and
 * the name in an intermediate group reads better and does not work: that
 * group would be a flex item with `min-width: auto`, whose content-based
 * minimum is the full width of a `whitespace-nowrap` name, so the group would
 * refuse to shrink and the name would never truncate at all. The usual cure,
 * `min-w-0` on the group, throws away the floor in the same breath — a floor
 * IS a minimum width. Flat, the floor sits directly on the name and there is
 * no wrapper left to lie about it.
 *
 * `flex-1` gives the name a flex base size of 0, so what flexbox measures it
 * at when deciding where to break the line is exactly the floor. The break
 * therefore happens the moment the floor plus the badges no longer fit:
 * badges to line two, name alone on line one with the whole width to
 * truncate into.
 *
 * Which is why the floor is spent on BADGES and on nothing else. A floor is
 * a claim on space that something else has to give back, and a badge is the
 * only thing on this row that can: it takes a second line and the name gets
 * the first one whole. A mark cannot move and a back link is not even in this
 * component, so a floor granted for either is a minimum width with no matching
 * concession — the row simply becomes wider than the box it is in. That is
 * exactly what it did on the tool page's title bar, where the band is one row
 * tall by contract: the `<h1>` wrapped under the logo, the row grew to 86px
 * inside a 48px band, and the title rendered outside it at every phone width.
 * A name with nothing beside it gets no floor for the same reason.
 *
 * `wrap={false}` is the other half of that lesson, for a row whose height is
 * not its own to spend. It is belt to the braces above: with the floor tied
 * to badges, a header that has none cannot break a line anyway — but the day
 * somebody adds one, the band should clip rather than silently grow.
 */
export function NameWithBadges({
  name,
  badges,
  leading,
  nameClassName,
  gap = 'gap-2',
  wrap = true,
  className,
  as: NameTag = 'span',
}: NameWithBadgesProps) {
  // The row follows its name, because what may legally contain what runs both
  // ways. A card and a plugin row are `<button>`s, whose content model is
  // phrasing — a `<div>` inside one is not markup — so the row is a `<span>`.
  // A page title is an `<h1>`, which a `<span>` may not contain for the same
  // rule read the other way round, so that row is a `<div>`.
  const Row = NameTag === 'h1' ? 'div' : 'span';
  return (
    <Row className={cn('flex min-w-0 items-center', wrap ? 'flex-wrap' : 'flex-nowrap', gap, className)}>
      {leading}
      <NameTag
        // Omitted rather than `title=""`: a tooltip that opens on nothing is
        // a tooltip that opens on nothing. A name can be missing — the row
        // still has to render whatever is beside it around the hole.
        title={name || undefined}
        className={cn('flex-1 truncate', badges && NAME_MIN_WIDTH, nameClassName)}
      >
        {name}
      </NameTag>
      {badges && (
        // `shrink-0`, so a badge is never squeezed into an unreadable pill —
        // the group moves as a unit instead. `max-w-full` is the one thing it
        // may not do: on its own line a group wider than the row would paint
        // over whatever is beside the row, so past that width the badges wrap
        // among THEMSELVES rather than overflow.
        <span className={cn('flex max-w-full shrink-0 flex-wrap items-center', gap)}>
          {badges}
        </span>
      )}
    </Row>
  );
}
