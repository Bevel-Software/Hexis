import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';

/**
 * An Allow remembered across a reload, round-tripped through the real
 * intermediaries: the REAL renderer on a stand-in file page, its card
 * clicked in a real browser, the digest kept in the browser's own
 * `localStorage` and read back by a new document after a real reload. The
 * unit suites run on happy-dom's storage; this is Chromium's.
 *
 * The origin is plain `http`, as `http://app:3001` is in local testing: not
 * a secure context, so no `crypto.subtle`, and the digest must still be the
 * SHA-256 Node computes for the same source.
 *
 * The memory is the signed-in account's: the real session hook resolves the
 * account from the stored token, and signs out through its real `logout`.
 *
 * The server is answered here: who a token belongs to, the UTCP manual (which
 * tools write) and the hosted MCP endpoint, recording every tool call that
 * reached it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ORIGIN = 'http://app.example';
const CARD = "You're allowing changes using your account. Do you want to allow that?";
const TOKEN_KEY = 'bevel_token';
const keyPrefix = (account: string) => `bevel.account/${account}/htmlPage.allowedWrite.`;
const KEY_PREFIX = keyPrefix('user-a');

/** A page whose button makes one writing call and shows how it went. */
const SOURCE = `<button id="write">write</button><pre id="out"></pre>
<script>
document.getElementById('write').addEventListener('click', () => {
  window.bevel.tools.callTool('edit_file', { body: { branch: 'main', path: 'Notes.md' } }).then(
    (r) => { document.getElementById('out').textContent = 'ok ' + JSON.stringify(r); },
    (e) => { document.getElementById('out').textContent = 'failed ' + e.code; },
  );
});
</script>`;

const HOST = '<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>';

let pageBundle: string | undefined;
/** The renderer's page entry (`fixtures/html-renderer-page.tsx`), bundled once per run. */
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

/** Answer the app's origin: the host page, whose token this is (the token names the account), the manual (edit_file writes), and the MCP endpoint. */
async function serve(page: Page): Promise<string[]> {
  const called: string[] = [];
  await page.route(`${APP_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/') return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: HOST });
    if (url.pathname === '/api/auth/me') {
      const account = (req.headers().authorization ?? '').replace('Bearer ', '');
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: account, email: `${account}@example.com`, name: account }),
      });
    }
    if (url.pathname === '/api/agent/utcp') {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tools: [{ name: 'knowledge_base.edit_file', tags: ['write'] }] }),
      });
    }
    if (url.pathname === '/api/mcp') {
      const rpc = req.postDataJSON() as { id: number; params: { name: string } };
      called.push(rpc.params.name);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { written: true } } }),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return called;
}

/**
 * Mount the real renderer showing `content` into the document the page holds
 * NOW — after `view` navigated to it, or after `page.reload()` replaced it.
 * Kept apart from the navigation so a reload test mounts into the reloaded
 * document rather than navigating once more and testing a fresh load.
 * `signedIn: false` mounts it with no account above it at all.
 */
async function mount(page: Page, content: string, { signedIn = true }: { signedIn?: boolean } = {}): Promise<void> {
  await page.addScriptTag({ content: await bundle() });
  await page.evaluate(
    ([source, withAccount]) =>
      window.mountHtmlPage({ content: source, filePath: 'knowledge-base/Dashboards/Roadmap.html', pagePath: 'Dashboards/Roadmap.html', signedIn: withAccount }),
    [content, signedIn] as const,
  );
  await expect(page.frameLocator('iframe').locator('#write')).toBeVisible();
}

/** The session this browser holds from now on: the next document's hook resolves this account. */
const signInAs = (page: Page, account: string) =>
  page.evaluate(([key, token]) => window.localStorage.setItem(key, token), [TOKEN_KEY, account] as const);

/** Load the app's page afresh, signed in as `user-a`, and mount the real renderer showing `content`. */
async function view(page: Page, content: string): Promise<void> {
  await page.goto(`${APP_ORIGIN}/`);
  await signInAs(page, 'user-a');
  await mount(page, content);
}

/** Every memory entry in the browser, any account's. */
const stored = (page: Page) => page.evaluate(() => Object.keys(window.localStorage).filter((k) => k.includes('allowedWrite')));

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test.use({ channel: 'chromium' });
// Bundling the renderer with vite takes most of this, more under a parallel run.
test.setTimeout(90_000);
// One worker for this file, so its tests share the one bundle `bundle()` caches:
// a build per test, in parallel, is what runs into the limit above.
test.describe.configure({ mode: 'default' });

test('Allow is kept in localStorage by the source\'s SHA-256, so a reload asks nothing; a changed source asks again', async ({ page }) => {
  const called = await serve(page);
  await view(page, SOURCE);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  const out = page.frameLocator('iframe').locator('#out');

  // First view: the card, then Allow runs the call and keeps the digest.
  await page.frameLocator('iframe').locator('#write').click();
  await expect(page.getByText(CARD)).toBeVisible();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(out).toHaveText('ok {"written":true}');
  expect(called).toEqual(['edit_file']);
  expect(await stored(page)).toEqual([KEY_PREFIX + sha256(SOURCE)]);

  // A real reload: a new document, the same browser storage, the renderer
  // mounted into THAT document (no second navigation). No card.
  await page.reload();
  await mount(page, SOURCE);
  await page.frameLocator('iframe').locator('#write').click();
  await expect(out).toHaveText('ok {"written":true}');
  await expect(page.getByText(CARD)).toHaveCount(0);
  expect(called).toEqual(['edit_file', 'edit_file']);

  // One character more: asked again; Allow keeps the new digest beside the old one.
  const edited = `${SOURCE} `;
  await page.reload();
  await mount(page, edited);
  await page.frameLocator('iframe').locator('#write').click();
  await expect(page.getByText(CARD)).toBeVisible();
  expect(called).toEqual(['edit_file', 'edit_file']);
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(out).toHaveText('ok {"written":true}');
  expect((await stored(page)).sort()).toEqual([KEY_PREFIX + sha256(SOURCE), KEY_PREFIX + sha256(edited)].sort());
});

test("another account is asked afresh for a source the first allowed, and signing out clears only the signed-out account's", async ({ page }) => {
  const called = await serve(page);
  const entryOf = (account: string) => keyPrefix(account) + sha256(SOURCE);
  const write = page.frameLocator('iframe').locator('#write');
  const out = page.frameLocator('iframe').locator('#out');
  const allow = page.getByRole('button', { name: 'Allow', exact: true });

  // user-a allows.
  await view(page, SOURCE);
  await write.click();
  await allow.click();
  await expect(out).toHaveText('ok {"written":true}');
  expect(await stored(page)).toEqual([entryOf('user-a')]);

  // user-b on the same browser and the same source: the card, nothing run until Allow.
  await signInAs(page, 'user-b');
  await page.reload();
  await mount(page, SOURCE);
  await write.click();
  await expect(page.getByText(CARD)).toBeVisible();
  expect(called).toEqual(['edit_file']);
  await allow.click();
  await expect(out).toHaveText('ok {"written":true}');
  expect(called).toEqual(['edit_file', 'edit_file']);
  expect((await stored(page)).sort()).toEqual([entryOf('user-a'), entryOf('user-b')]);

  // user-b signs out through the app's own hook: their entry goes, user-a's stays.
  await page.evaluate(() => window.signOutHtmlPage());
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), TOKEN_KEY)).toBeNull();
  expect(await stored(page)).toEqual([entryOf('user-a')]);

  // user-b back: asked afresh.
  await signInAs(page, 'user-b');
  await page.reload();
  await mount(page, SOURCE);
  await write.click();
  await expect(page.getByText(CARD)).toBeVisible();
  await page.getByRole('button', { name: "Don't allow" }).click();

  // user-a back: still remembered.
  await signInAs(page, 'user-a');
  await page.reload();
  await mount(page, SOURCE);
  await write.click();
  await expect(out).toHaveText('ok {"written":true}');
  await expect(page.getByText(CARD)).toHaveCount(0);
});

test('with no signed-in account above the renderer nothing is kept, and every view asks', async ({ page }) => {
  const called = await serve(page);
  await page.goto(`${APP_ORIGIN}/`);
  await mount(page, SOURCE, { signedIn: false });
  const out = page.frameLocator('iframe').locator('#out');

  await page.frameLocator('iframe').locator('#write').click();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(out).toHaveText('ok {"written":true}');
  expect(called).toEqual(['edit_file']);
  expect(await stored(page)).toEqual([]);

  await page.reload();
  await mount(page, SOURCE, { signedIn: false });
  await page.frameLocator('iframe').locator('#write').click();
  await expect(page.getByText(CARD)).toBeVisible();
});

test("Don't allow keeps nothing in localStorage, and the reloaded page asks again", async ({ page }) => {
  const called = await serve(page);
  await view(page, SOURCE);
  const out = page.frameLocator('iframe').locator('#out');

  await page.frameLocator('iframe').locator('#write').click();
  await page.getByRole('button', { name: "Don't allow" }).click();
  await expect(out).toHaveText('failed denied');
  expect(called).toEqual([]);
  expect(await stored(page)).toEqual([]);

  await page.reload();
  await mount(page, SOURCE);
  await page.frameLocator('iframe').locator('#write').click();
  await expect(page.getByText(CARD)).toBeVisible();
});
