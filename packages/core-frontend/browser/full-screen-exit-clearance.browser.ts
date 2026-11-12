import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { compile } from 'tailwindcss';
import { build, type Rollup } from 'vite';

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

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let harnessBundle: string | undefined;
async function bundle(): Promise<string> {
  if (harnessBundle) return harnessBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/full-bleed-full-screen.tsx'), formats: ['iife'], name: 'FullBleedHarness', fileName: () => 'full-bleed.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the harness bundle produced no chunk');
  harnessBundle = chunk.code;
  return harnessBundle;
}

/** Tailwind and the design tokens, built for every class the harness names. */
let stylesheet: string | undefined;
async function css(): Promise<string> {
  if (stylesheet) return stylesheet;
  const themeDir = path.resolve(here, '../src/shared/theme');
  const tailwindCss = require.resolve('tailwindcss/index.css');
  const compiled = await compile(`@import 'tailwindcss';\n@import './index.css';\n`, {
    base: themeDir,
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? tailwindCss : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  const candidates = Array.from(new Set((await bundle()).split(/[\s"'`,;{}()<>=]+/).filter(Boolean)));
  stylesheet = compiled.build(candidates);
  return stylesheet;
}

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
  });
}
