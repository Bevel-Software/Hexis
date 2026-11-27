import { expect, test } from '@playwright/test';
import { appStylesheet, bundleFixture } from './harness';

/**
 * The harness builds the stylesheet for every class a fixture names,
 * arbitrary values included. A class it fails to read gets no CSS, and a
 * layout suite then measures an unstyled page without saying so. These read
 * the computed style of the classes a split on punctuation breaks.
 */

const entry = 'arbitrary-classes.ts';

// Bundling the fixture with vite and building its stylesheet takes most of this.
test.setTimeout(90_000);

test('classes with brackets, parentheses and commas are styled', async ({ page }) => {
  await page.setContent(`<!doctype html><html><head><style>${await appStylesheet(entry)}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: await bundleFixture(entry) });
  const styles = await page.evaluate(() => {
    const el = (selector: string) => document.querySelector(selector)!;
    const a = el('[data-cell="a"]').getBoundingClientRect();
    const b = el('[data-cell="b"]').getBoundingClientRect();
    return {
      columns: getComputedStyle(el('[data-grid]')).gridTemplateColumns,
      a: { top: a.top, left: a.left, width: a.width },
      b: { top: b.top, left: b.left, width: b.width },
      slotPadding: getComputedStyle(el('[data-slot]')).paddingRight,
      shadow: getComputedStyle(el('[data-shadow]')).boxShadow,
    };
  });
  // `grid-cols-[repeat(2,1fr)]`: two equal columns, the cells side by side in one row.
  expect(styles.columns).toBe('200px 200px');
  expect(styles.b.top).toBe(styles.a.top);
  expect(styles.b.left).toBe(styles.a.left + 200);
  // `[[data-full-screen]_&]:pr-9`: 36px under a `data-full-screen` ancestor.
  expect(styles.slotPadding).toBe('36px');
  // `shadow-[0_0_0_3px_rgba(255,0,0,0.5)]`.
  expect(styles.shadow).toContain('rgba(255, 0, 0, 0.5)');
});
