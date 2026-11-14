import { expect } from 'vitest';
import { TITLE_INK_ROOM } from '../shared/theme/header';

/**
 * The page-title contract every header band's test asserts: the title keeps
 * the tails of its g, y and p while still truncating with an ellipsis.
 *
 * happy-dom lays nothing out, so clipping cannot be measured here. What can
 * be checked is the shape that makes it impossible: the title truncates
 * (`truncate` — `overflow: hidden`, which is what clips), and EVERY box that
 * clips between the title and the band carries `TITLE_INK_ROOM` — the title
 * itself and any `overflow-hidden` wrapper it is grouped in. A wrapper that
 * lacks it clips to the title's line box and cuts the tails off one box
 * further out, which is exactly what this guards against. The geometry of
 * the class (padding that is handed back as margin) is pinned once, against
 * the compiled stylesheet, in `HeaderAlignment.test.tsx`.
 */
export function expectTitleKeepsItsInk(band: HTMLElement): void {
  const title = band.querySelector('h1');
  expect(title, 'the band holds the page title').not.toBeNull();
  const room = TITLE_INK_ROOM.split(/\s+/);
  expect([...title!.classList], 'the title truncates with an ellipsis').toContain('truncate');
  expect([...title!.classList], 'the title has room for its tails').toEqual(expect.arrayContaining(room));
  for (let box = title!.parentElement; box && box !== band; box = box.parentElement) {
    if (!box.classList.contains('overflow-hidden')) continue;
    expect([...box.classList], `a wrapper that clips the title (${box.className}) has the same room`).toEqual(
      expect.arrayContaining(room),
    );
  }
}
