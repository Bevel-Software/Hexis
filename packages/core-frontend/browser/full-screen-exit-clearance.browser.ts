import { expect, test, type Page } from '@playwright/test';
import { appStylesheet, bundleFixture } from './harness';

/**
 * A full-bleed file in full screen puts Download beside the exit control, in
 * one row, and the control covers none of it.
 *
 * The exit control is pinned to the window's top right corner, above the
 * renderer. A PDF's and a spreadsheet's toolbar ends in Download at that same
 * corner, and when the renderer ran flush to the window's top the control sat
 * on top of it: Download could only be clicked at its left edge. Whether two
 * boxes overlap, and whether they share a row, is layout, which happy-dom does
 * not do, so it is asked of a browser, over the real surface classes, the real
 * exit control and the app's own stylesheet.
 */

const bundle = () => bundleFixture('full-bleed-full-screen.tsx');

const css = () => appStylesheet('full-bleed-full-screen.tsx');

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

async function mount(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.setContent(`<!doctype html><html><head><style>${await css()}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: await bundle() });
  await page.waitForSelector('[data-testid="exit-full-screen"]');
  return page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { top: r.top, right: r.right, bottom: r.bottom, left: r.left };
    };
    return {
      exit: box('[data-testid="exit-full-screen"]'),
      download: box('[data-download]'),
      toolbar: box('[data-toolbar]'),
    };
  });
}

const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Bundling the harness with vite and building its stylesheet takes most of this, more under a parallel run.
test.setTimeout(90_000);
// One worker for this file, so its tests share the one bundle `bundle()` caches:
// a build per test, in parallel, is what runs into the limit above.
test.describe.configure({ mode: 'default' });

for (const width of [1400, 390]) {
  test(`at ${width}px wide, Download sits right beside the exit control, in one row, uncovered`, async ({ page }) => {
    const { exit, download, toolbar } = await mount(page, width);
    expect(overlaps(exit, download)).toBe(false);
    // One row: no band above the toolbar. It starts level with the control...
    expect(Math.abs(toolbar.top - exit.top)).toBeLessThanOrEqual(2);
    // ...and Download is centred on the control's line, within a pixel.
    const middle = (b: Box) => (b.top + b.bottom) / 2;
    expect(Math.abs(middle(download) - middle(exit))).toBeLessThanOrEqual(1);
    // Beside it: the toolbar's own 8px gap between the two, Download first.
    expect(exit.left - download.right).toBeCloseTo(8, 0);
    // Clickable, not only drawn clear: a click at Download's right end, where
    // the control used to sit, reaches Download. Playwright hit-tests the point
    // and refuses a click another element would intercept, so an invisible
    // layer over Download fails here even when the boxes do not overlap.
    const button = page.locator('[data-download]');
    const size = (await button.boundingBox())!;
    await button.click({ position: { x: size.width - 2, y: size.height / 2 }, timeout: 3000 });
  });
}
