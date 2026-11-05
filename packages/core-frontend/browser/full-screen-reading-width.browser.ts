import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { compile } from 'tailwindcss';
import { build, type Rollup } from 'vite';
import { DOCUMENT_COLUMN_CONTENT } from '../src/shared/theme/measure';

/**
 * Full screen keeps the reader's line, in a real layout.
 *
 * The unit suite proves the arithmetic of the carry with the geometry given
 * (happy-dom lays nothing out); what it cannot answer is the thing that
 * failed on staging: whether the text, laid out by a browser at the width
 * the page measured, wraps line for line as it did on the page, so that the
 * carried offset lands the reader on the same line — and not six sections
 * further, as it did when the full-screen card was 80px wider. So this is
 * asked of a browser, over the real card, the real column constants and the
 * real carry, with the page's own stylesheet compiled for the page
 * (Round-Trip Through the Real Intermediary).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The harness, bundled for a browser page once per run. */
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
      lib: { entry: path.resolve(here, 'fixtures/full-screen-reading.tsx'), formats: ['iife'], name: 'ReadingHarness', fileName: () => 'reading.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the harness bundle produced no chunk');
  harnessBundle = chunk.code;
  return harnessBundle;
}

/**
 * The app's stylesheet for the page: Tailwind and the design tokens
 * (`src/shared/theme`), built for every class the harness bundle names —
 * the card's, the column's, the surface's. The typography plugin is left
 * out: the harness renders plain paragraphs, not the Markdown renderer.
 */
let stylesheet: string | undefined;
async function css(): Promise<string> {
  if (stylesheet) return stylesheet;
  const themeDir = path.resolve(here, '../src/shared/theme');
  const tailwindCss = require.resolve('tailwindcss/index.css');
  const entry = `@import 'tailwindcss';\n@import './index.css';\n`;
  const compiled = await compile(entry, {
    base: themeDir,
    loadStylesheet: async (id, base) => {
      const file = id === 'tailwindcss' ? tailwindCss : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  // Every token in the bundle is a candidate; Tailwind keeps the utilities.
  const candidates = Array.from(new Set((await bundle()).split(/[\s"'`,;{}()<>=]+/).filter(Boolean)));
  stylesheet = compiled.build(candidates);
  return stylesheet;
}

/** The column's content width, from the constant the view uses: `max-w-[800px]` → 800. */
const CONTENT_WIDTH = Number(/max-w-\[(\d+)px\]/.exec(DOCUMENT_COLUMN_CONTENT)![1]);

interface Geometry {
  cardWidth: number;
  /** Each paragraph's height, in order: equal lists mean the same wrap. */
  heights: number[];
}

async function mount(page: Page, opts: { filling?: boolean } = {}) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.setContent(`<!doctype html><html><head><style>${await css()}</style></head><body><div id="root"></div></body></html>`);
  await page.addScriptTag({ content: await bundle() });
  await page.evaluate((o) => window.reading.mount(o), opts);
  await page.waitForSelector('[data-paragraph="60"]');

  const geometry = (): Promise<Geometry> =>
    page.evaluate(() => ({
      cardWidth: document.querySelector('[data-file-pane-body]')!.parentElement!.getBoundingClientRect().width,
      heights: Array.from(document.querySelectorAll('[data-paragraph]'), (p) => p.getBoundingClientRect().height),
    }));
  /** Scroll the scroller in use so paragraph `n`'s top sits `below` px under its top edge. */
  const scrollTo = (n: number, below: number) =>
    page.evaluate(
      ({ n, below }) => {
        const scroller = document.querySelector<HTMLElement>(window.reading.filling() ? '[data-pane]' : '[data-shell]')!;
        const p = document.querySelector(`[data-paragraph="${n}"]`)!;
        scroller.scrollTop += p.getBoundingClientRect().top - scroller.getBoundingClientRect().top - below;
      },
      { n, below },
    );
  /** How far paragraph `n`'s top is below the scroller's top edge now. */
  const below = (n: number) =>
    page.evaluate((n) => {
      const scroller = document.querySelector<HTMLElement>(window.reading.filling() ? '[data-pane]' : '[data-shell]')!;
      const p = document.querySelector(`[data-paragraph="${n}"]`)!;
      return p.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }, n);
  const enter = async () => {
    await page.evaluate(() => window.reading.enter());
    await page.waitForFunction(() => window.reading.filling() && document.querySelector('[data-pane]')!.hasAttribute('class'));
  };
  const leave = async () => {
    await page.evaluate(() => window.reading.leave());
    await page.waitForFunction(() => !window.reading.filling());
  };
  const cardStyleMaxWidth = () => page.evaluate(() => (document.querySelector('[data-file-pane-body]')!.parentElement as HTMLElement).style.maxWidth);
  return { geometry, scrollTo, below, enter, leave, cardStyleMaxWidth };
}

test('entering and leaving full screen keeps the same line at the top, because the text keeps its width', async ({ page }) => {
  const r = await mount(page);
  const onPage = await r.geometry();
  expect(onPage.cardWidth).toBe(CONTENT_WIDTH);
  // Deep in the document: paragraph 40 (Section 8), 37px below the top edge.
  await r.scrollTo(40, 37);
  expect(await r.below(40)).toBeCloseTo(37, 0);

  await r.enter();
  const filling = await r.geometry();
  // Every paragraph is as tall as it was: the same wrap, line for line.
  expect(filling.heights).toEqual(onPage.heights);
  expect(filling.cardWidth).toBe(onPage.cardWidth);
  expect(await r.cardStyleMaxWidth()).toBe(`${onPage.cardWidth}px`);
  // And the reader is where they were.
  expect(await r.below(40)).toBeCloseTo(37, 0);

  // Read on to paragraph 52 (Section 11), then leave: the page lands there.
  await r.scrollTo(52, 10);
  await r.leave();
  const back = await r.geometry();
  expect(back.heights).toEqual(onPage.heights);
  expect(await r.cardStyleMaxWidth()).toBe('');
  expect(await r.below(52)).toBeCloseTo(10, 0);
});

test('opened by a full-screen link, with no page to match, the text takes the column\'s content width', async ({ page }) => {
  const r = await mount(page, { filling: true });
  const g = await r.geometry();
  expect(g.cardWidth).toBe(CONTENT_WIDTH);
  expect(await r.cardStyleMaxWidth()).toBe('');
});
