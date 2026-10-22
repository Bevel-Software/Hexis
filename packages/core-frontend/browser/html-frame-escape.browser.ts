import { expect, test, type Page } from '@playwright/test';
import { buildSandboxedHtml } from '../src/modules/workspace/components/renderers/htmlSandbox';
import { isFrameEscape } from '../src/modules/workspace/utils/frameEscape';

/**
 * Escape pressed with focus inside an HTML page's frame, in a real browser,
 * over a real sandboxed `srcdoc` frame: the key bridge the sandbox emits on
 * one side, the full-screen view's own check of what reached the window
 * (`isFrameEscape`, loaded into the host from its source — it closes over
 * nothing) on the other, and the browser's keyboard and `postMessage` between.
 *
 * What a stand-in document cannot answer: that a key pressed in the frame
 * reaches only the frame, that the bridge's message crosses the sandbox's
 * opaque origin to the parent, that its `source` is the frame element's
 * `contentWindow` the view looks for, and that a handler the page adds after
 * the bridge's — a module of the page's own, which runs after the bridge's —
 * still keeps an Escape it cancels to the page.
 */

/**
 * A host standing in for the full-screen view: the surface holding the page's
 * frame, a second frame outside it, and the view's relay — an Escape the
 * check accepts is pressed again on the document, where it is counted.
 */
const HOST = `<!doctype html>
<html><body style="margin:0">
<div id="surface"><iframe id="page" sandbox="allow-scripts" style="width:600px;height:200px"></iframe></div>
<iframe id="other" sandbox="allow-scripts" style="width:600px;height:200px"></iframe>
<script>
  window.escapes = 0;
  window.ready = (isFrameEscape) => {
    const surface = document.getElementById('surface');
    window.addEventListener('message', (e) => {
      if (!isFrameEscape(e, surface)) return;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.escapes += 1;
    });
  };
</script>
</body></html>`;

/** A page with a popup of its own, whose Escape handler a module adds after the bridge's. */
const PAGE_BODY = `<button id="open">Open popup</button>
<p id="state">closed</p>
<script type="module">
  let open = false;
  const state = document.getElementById('state');
  document.getElementById('open').addEventListener('click', () => {
    open = true;
    state.textContent = 'open';
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !open) return;
    e.preventDefault();
    open = false;
    state.textContent = 'closed by the page';
  });
</script>`;

async function host(page: Page) {
  await page.setContent(HOST);
  const doc = buildSandboxedHtml({ title: 'page', libModuleSources: [], bodyHtml: PAGE_BODY });
  await page.evaluate((srcdoc) => {
    (document.getElementById('page') as HTMLIFrameElement).srcdoc = srcdoc;
    (document.getElementById('other') as HTMLIFrameElement).srcdoc = srcdoc;
  }, doc);
  await page.addScriptTag({ content: `window.ready(${isFrameEscape.toString()});` });
  const frame = page.frameLocator('#page');
  const other = page.frameLocator('#other');
  await expect(frame.locator('#open')).toBeVisible();
  await expect(other.locator('#open')).toBeVisible();
  const escapes = () => page.evaluate(() => (window as unknown as { escapes: number }).escapes);
  return { frame, other, escapes };
}

test('an Escape the page left alone reaches the view; one the page cancelled stays the page\'s', async ({ page }) => {
  const h = await host(page);

  // Focus inside the frame: the key is the frame's document's, not the host's.
  await h.frame.locator('#state').click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('page');
  await page.keyboard.press('Escape');
  await expect.poll(h.escapes).toBe(1);

  // The page's popup is open: its handler, added after the bridge's, cancels
  // the Escape, and the view never hears of it.
  await h.frame.locator('#open').click();
  await page.keyboard.press('Escape');
  await expect(h.frame.locator('#state')).toHaveText('closed by the page');
  // The popup is closed now, so the next Escape is the view's. Messages from
  // one frame arrive in order: had the cancelled one been posted, the count
  // would read 3 here.
  await page.keyboard.press('Escape');
  await expect.poll(h.escapes).toBe(2);
  await page.waitForTimeout(100);
  expect(await h.escapes()).toBe(2);

  // Any other key stays in the frame.
  await page.keyboard.press('a');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(await h.escapes()).toBe(2);
});

test('an Escape from a frame outside the view\'s surface is not the view\'s', async ({ page }) => {
  const h = await host(page);
  await h.other.locator('#state').click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('other');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  expect(await h.escapes()).toBe(0);

  // The same key from the page inside the surface is.
  await h.frame.locator('#state').click();
  await page.keyboard.press('Escape');
  await expect.poll(h.escapes).toBe(1);
});
