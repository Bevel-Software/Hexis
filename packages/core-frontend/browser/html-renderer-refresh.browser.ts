import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';

/**
 * Refresh paints the page again, in a real browser.
 *
 * What failed on staging: every click of Refresh on an HTML file page left
 * the frame blank. The document loaded and its runtime ran, but it was
 * never laid out — the renderer mounted the new frame with the PREVIOUS
 * view's document and swapped the new one in a moment later, mid-load, and
 * Chromium does not paint a sandboxed frame whose `srcdoc` is replaced that
 * early. The unit suite's DOM lays nothing out and cannot see it; so this is
 * asked of a browser, over the real renderer on a stand-in file page.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

let pageBundle: string | undefined;
async function bundle(): Promise<string> {
  if (pageBundle) return pageBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/html-renderer-page.tsx'), formats: ['iife'], name: 'HtmlRendererPage', fileName: () => 'html-page.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the page bundle produced no chunk');
  pageBundle = chunk.code;
  return pageBundle;
}

async function mount(page: Page) {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.setContent('<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>');
  await page.addScriptTag({ content: await bundle() });
  await page.evaluate(() =>
    window.mountHtmlPage({
      content: '<h1 id="title" style="margin:0;height:40px">Roadmap</h1>',
      filePath: 'knowledge-base/Dashboards/Roadmap.html',
      pagePath: 'Dashboards/Roadmap.html',
    }),
  );
}

/** The page's heading as the browser laid it out inside the frame: its height, 0 when the document was never laid out. */
async function paintedHeight(page: Page): Promise<number> {
  const heading = page.frameLocator('iframe').locator('#title');
  await expect(heading).toHaveText('Roadmap');
  // Give a document that is going to be laid out time to be, so a blank one is told from a slow one.
  await page.waitForTimeout(400);
  return (await heading.evaluate((el) => el.getBoundingClientRect().height)) as number;
}

// Full Chromium, not the default headless shell: the shell lays out a frame
// whose srcdoc was swapped mid-load and so passes the defect this test is
// for; full Chromium (what a reader's browser is) leaves it blank. `playwright
// install chromium` installs both.
test.use({ channel: 'chromium' });

test('the page is painted on first view and after every Refresh', async ({ page }) => {
  await mount(page);
  expect(await paintedHeight(page)).toBe(40);
  for (let i = 0; i < 3; i += 1) {
    await page.getByTitle('Reload preview').click();
    expect(await paintedHeight(page)).toBe(40);
  }
});
