import { expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { PAGE_HEADER_TESTID } from '../../../shared/theme/header';

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
 * pins — in the band, last, in a group that neither shrinks nor wraps.
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
}
