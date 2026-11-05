import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';

/**
 * A link written in an HTML page opens its target in a new tab, in a real
 * browser: a real click on a real anchor inside the real sandboxed frame,
 * the frame's nav bridge posting across the sandbox's opaque origin, the
 * REAL renderer following it with the window it opens, and the browser
 * opening the tab. The unit suite posts the bridge's message by hand and
 * stubs `window.open`; what a stand-in cannot answer is that the click
 * reaches the bridge at all (the sandbox has no `allow-popups`, so left to
 * the browser a click opens nothing), that the message crosses to the
 * parent, and that a tab really opens at the target's plain address while
 * this one stays where it is.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** The origin the stand-in app is served from, so the tab the link opens has a real address to be read back. */
const ORIGIN = 'http://app.test';
const PAGE_URL = `${ORIGIN}/workspace/main/knowledge-base/Dashboards/Roadmap.html`;
const TARGET_URL = `${ORIGIN}/workspace/main/knowledge-base/Plans/roadmap.md`;

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

/**
 * Serve the stand-in app at a real origin: the file page's shell, and a plain
 * page for whatever a link opens. On the CONTEXT, not the page: the tab a
 * link opens is a page of its own, and a route on the opener would leave it
 * to the network, where `app.test` does not exist.
 */
async function serve(page: Page): Promise<void> {
  await page.context().route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    const body =
      url === PAGE_URL
        ? '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'
        : `<!doctype html><html><body><h1 id="opened">${url.slice(ORIGIN.length)}</h1></body></html>`;
    void route.fulfill({ status: 200, contentType: 'text/html', body });
  });
}

async function mount(page: Page) {
  await serve(page);
  await page.goto(PAGE_URL);
  await page.addScriptTag({ content: await bundle() });
  await page.evaluate(() =>
    window.mountHtmlPage({
      content:
        '<h1 id="title">Roadmap</h1>' +
        '<p><a id="plan" href="../Plans/roadmap.md">The plan</a> · <a id="here" href="#title">Top</a></p>',
      filePath: 'knowledge-base/Dashboards/Roadmap.html',
      pagePath: 'Dashboards/Roadmap.html',
    }),
  );
  const frame = page.frameLocator('iframe');
  await expect(frame.locator('#plan')).toBeVisible();
  return frame;
}

test.use({ channel: 'chromium' });
// Bundling the renderer with vite takes most of this, more under a parallel run.
test.setTimeout(90_000);

test('a click on a link to another file opens that file in a new tab, and this tab stays where it is', async ({ page }) => {
  const frame = await mount(page);
  const opened = page.context().waitForEvent('page');
  await frame.locator('#plan').click();
  const tab = await opened;
  await tab.waitForLoadState();
  expect(tab.url()).toBe(TARGET_URL);
  await expect(tab.locator('#opened')).toHaveText('/workspace/main/knowledge-base/Plans/roadmap.md');
  // This tab: same address, same page, the frame still showing the document.
  expect(page.url()).toBe(PAGE_URL);
  await expect(frame.locator('#title')).toHaveText('Roadmap');
  await tab.close();
});

test('a link to a section of the same page scrolls in place and opens nothing', async ({ page }) => {
  const frame = await mount(page);
  let opened = 0;
  page.context().on('page', () => {
    opened += 1;
  });
  await frame.locator('#here').click();
  await page.waitForTimeout(300);
  expect(opened).toBe(0);
  expect(page.url()).toBe(PAGE_URL);
});
