import { expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { PAGE_HEADER_TESTID } from '../../../shared/theme/header';
import { DOCUMENT_COLUMN } from '../../../shared/theme/measure';

/**
 * The one width an item page is allowed to be: the shared document measure,
 * which the Library layout's `<main>` already puts around every page.
 */
const SHARED_MEASURE = DOCUMENT_COLUMN.split(' ').filter((c) => c.startsWith('max-w-'));

/**
 * Where an item page's `⋯` goes: the right end of the title row.
 *
 * Shared between `PluginPage.test.tsx` and `ToolPage.test.tsx` because the
 * acceptance criterion is a COMPARISON — "the same position and size as on the
 * plugin page" — and two hand-written copies of it would be two things that can
 * drift apart while both stay green. One function, asserted on both pages: the
 * day one of them moves its menu, exactly one of the two callers fails and the
 * other says what it was supposed to look like.
 *
 * The tool page used to render `PageActions` as the last child of its
 * `<header>`, after the description paragraph — a menu on its own line under
 * the way back, at the left margin, which is where nothing else on any page
 * is.
 *
 * Size needs no assertion of its own: it is the same `PageActions` component,
 * so the only thing that could differ is where it is put. That is what this
 * pins — in the band, last, in a group that neither shrinks nor wraps: that,
 * plus {@link expectTitleRowSpansTheDocumentColumn} for the row's WIDTH, is
 * the whole of "the same position".
 */
export function expectMenuAtTheEndOfTheTitleRow(): void {
  const band = screen.getByTestId(PAGE_HEADER_TESTID);
  const menu = within(band).getByRole('button', { name: 'More actions' });

  // LAST in the band. The title before it carries `flex-1`, so "last" is what
  // puts the group against the row's right edge — there is no `ml-auto` doing
  // it invisibly from somewhere else.
  expect(band.lastElementChild).toContainElement(menu);

  // The group the plugin page puts it in: fixed width, on the band's line.
  const group = band.lastElementChild as HTMLElement;
  expect(group.className).toContain('flex');
  expect(group.className).toContain('flex-none');
  expect(group.className).toContain('items-center');

  // And nothing else in the page's header renders one — a second `⋯` under
  // the back link is the bug this replaced.
  const header = band.closest('header') ?? band.parentElement!;
  expect(within(header).getAllByRole('button', { name: 'More actions' })).toHaveLength(1);

  // Last in a right-aligned row says WHERE ON the row; this says where the row
  // ENDS. Both are needed, and only the pair is the criterion.
  expectTitleRowSpansTheDocumentColumn();
}

/**
 * The title row runs the full width of the shared document column — the page
 * wraps it in no narrower measure of its own.
 *
 * This is the half of "the same position as on the plugin page" that structure
 * alone cannot see, and the half that shipped broken. The tool page put its
 * band, correctly, last-in-row inside a group with the plugin page's exact
 * classes — and rendered it 16px left of the plugin page's, every viewport,
 * because the article around it was `max-w-3xl` (768px) inside the layout's
 * 800px line. Every structural assertion above passed on both pages while the
 * two menus sat at different points on the screen; staging found it with a
 * ruler, which is not a thing this suite can do.
 *
 * So it asserts the CAUSE rather than the pixels: jsdom computes no layout, but
 * the width of a page's title row is decided entirely by which ancestors
 * constrain it, and the layout's `<main>` is the only one entitled to. Anything
 * else between the band and the document is a second column inside the first,
 * and the row cannot reach the same right edge as a page that has none.
 */
export function expectTitleRowSpansTheDocumentColumn(): void {
  const band = screen.getByTestId(PAGE_HEADER_TESTID);
  const narrowed: string[] = [];
  for (let el = band.parentElement; el && el !== document.body; el = el.parentElement) {
    for (const cls of Array.from(el.classList)) {
      // `DOCUMENT_COLUMN` itself is allowed through: a test that renders the
      // page inside `LibraryLayout` passes the shared measure on the way up,
      // and the shared measure is the one width the row is meant to have.
      if (cls.startsWith('max-w-') && !SHARED_MEASURE.includes(cls)) {
        narrowed.push(`<${el.tagName.toLowerCase()} class="${el.className}">`);
      }
    }
  }
  expect(
    narrowed,
    `The title row is inside a narrower column than the document measure (${SHARED_MEASURE.join(' ')}), ` +
      'so its right end — and the ⋯ on it — cannot line up with the plugin page\'s.',
  ).toEqual([]);
}
