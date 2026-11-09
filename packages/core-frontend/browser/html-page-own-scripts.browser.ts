import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { buildSandboxedHtmlIn, sanitizeAgentHtmlIn } from './fixtures/sandboxed-document';

/**
 * A page runs only the scripts it ships with, in a real browser: the frame's
 * document built by the real sanitizer and builder in Chromium, loaded into a
 * real sandboxed `srcdoc` frame, and Chromium's own Content-Security-Policy
 * enforcement deciding what runs. A stand-in DOM enforces no policy at all.
 *
 * Every probe reports by `postMessage` to the host, so a probe that ran is
 * heard even when it replaced the frame's document (`document.write`). Each
 * refused probe is also counted by the frame's `securitypolicyviolation`
 * events, so the test waits for the refusal rather than for a while.
 *
 * The control at the end loads the same document under the policy this
 * replaced (`script-src 'unsafe-inline'`): there the same probes run, so the
 * refusals above are the policy's doing and not the probes' failing.
 */

const HOST = `<!doctype html><html><body style="margin:0">
<iframe id="f" sandbox="allow-scripts" style="width:600px;height:300px"></iframe>
<script>
  window.heard = [];
  window.addEventListener('message', (e) => { if (typeof e.data === 'string') window.heard.push(e.data); });
</script>
</body></html>`;

/** The shipped handler, word for word: a runtime handler of the same text may run, any other may not. */
const SHIPPED_HANDLER = "parent.postMessage('handler', '*')";
/** The second shipped script, word for word, for the same reason. */
const SHIPPED_SCRIPT = "parent.postMessage('shipped', '*');";

const PAGE = `<button id="btn" onclick="${SHIPPED_HANDLER}">shipped handler</button>
<button id="other">runtime handler</button>
<div id="slot"></div>
<script>
  window.violations = 0;
  document.addEventListener('securitypolicyviolation', () => { window.violations += 1; });
  parent.postMessage('first:' + typeof window.bevel, '*');
  try { eval('1'); parent.postMessage('eval ran', '*'); } catch (err) { parent.postMessage('eval refused', '*'); }
</script>
<script>${SHIPPED_SCRIPT}</script>`;

const heard = (page: Page) => page.evaluate(() => (window as unknown as { heard: string[] }).heard.slice());
const violations = (frame: FrameLocator) => frame.locator('body').evaluate(() => (window as unknown as { violations: number }).violations);

/**
 * Load PAGE into the host's frame, built in the browser. `policy` replaces
 * the built policy (the control); `sandboxed: false` takes the frame's
 * sandbox off, leaving the policy the only gate.
 */
async function load(page: Page, { policy, sandboxed = true }: { policy?: (built: string) => string; sandboxed?: boolean } = {}): Promise<FrameLocator> {
  await page.setContent(HOST);
  if (!sandboxed) await page.evaluate(() => document.getElementById('f')!.removeAttribute('sandbox'));
  const bodyHtml = await sanitizeAgentHtmlIn(page, PAGE);
  let srcdoc = await buildSandboxedHtmlIn(page, { title: 'page', libModuleSources: [], bodyHtml });
  if (policy) srcdoc = policy(srcdoc);
  await page.evaluate((doc) => {
    (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc;
  }, srcdoc);
  await expect.poll(() => heard(page)).toContain('shipped');
  return page.frameLocator('#f');
}

/*
 * The probes below run inside the frame, as the page's own code would.
 * Playwright compiles each probe outside the frame's policy; what it
 * inserts, sets or navigates to is the frame's, and subject to it.
 */

/** Append a script of `text` (a module when `module`), as a page reading a file and inserting it would. */
const insertScript = (frame: FrameLocator, text: string, module = false) =>
  frame.locator('body').evaluate(
    (_, [t, m]) => {
      const s = document.createElement('script');
      if (m) s.type = 'module';
      s.textContent = t;
      document.body.appendChild(s);
    },
    [text, module] as const,
  );
/** Set the second button's `onclick` attribute to `text`. */
const setHandler = (frame: FrameLocator, text: string) =>
  frame.locator('body').evaluate((_, t) => document.getElementById('other')!.setAttribute('onclick', t), text);
/** Set `#slot`'s `innerHTML`. */
const setSlot = (frame: FrameLocator, html: string) =>
  frame.locator('body').evaluate((_, h) => {
    document.getElementById('slot')!.innerHTML = h;
  }, html);
/**
 * Follow a link to `url`, as a reader's click would. The link stops the
 * click's propagation, so the nav bridge (which cancels every link click and
 * posts it to the parent) leaves the browser to follow it.
 */
const navigate = (frame: FrameLocator, url: string) =>
  frame.locator('body').evaluate((_, u) => {
    const a = document.createElement('a');
    a.href = u;
    a.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(a);
    a.click();
  }, url);
const ONERROR = `<img src="x" onerror="parent.postMessage('onerror', '*')">`;
const JAVASCRIPT_URL = "javascript:parent.postMessage('javascript', '*')";

test('every script and handler the page ships runs, in source order, after the runtime', async ({ page }) => {
  const frame = await load(page);
  expect(await heard(page)).toEqual(['first:object', 'eval refused', 'shipped']);
  await frame.locator('#btn').click();
  await expect.poll(() => heard(page)).toContain('handler');
});

test('a script inserted at runtime does not run, unless its text is one the page ships', async ({ page }) => {
  const frame = await load(page);
  const base = await violations(frame);
  await insertScript(frame, "parent.postMessage('created', '*')");
  await insertScript(frame, "parent.postMessage('created module', '*')", true);
  await insertScript(frame, ` ${SHIPPED_SCRIPT}`, true); // one space away from a shipped script
  await expect.poll(() => violations(frame)).toBe(base + 3);
  // The same text as a shipped script matches its hash: it runs nothing the source did not hold.
  await insertScript(frame, SHIPPED_SCRIPT, true);
  await expect.poll(async () => (await heard(page)).filter((m) => m === 'shipped').length).toBe(2);
  expect(await heard(page)).not.toContain('created');
  expect(await heard(page)).not.toContain('created module');
});

/** Replace the frame's document through `document.write`, with a script that reports. */
const writeDocument = (frame: FrameLocator) =>
  frame.locator('body').evaluate(() => {
    document.open();
    document.write('<p id="written">written</p><script>parent.postMessage("written", "*")</scr' + 'ipt>');
    document.close();
  });

test('a script written with document.write does not run', async ({ page }) => {
  const frame = await load(page);
  await writeDocument(frame);
  await expect(frame.locator('#written')).toHaveText('written');
  // The written document listens for nothing; the host's log is the witness, given the time a run would take.
  await page.waitForTimeout(300);
  expect(await heard(page)).not.toContain('written');
});

test('a handler added at runtime does not run, by attribute or through innerHTML, unless its text is one the page ships', async ({ page }) => {
  const frame = await load(page);
  const base = await violations(frame);
  await setHandler(frame, "parent.postMessage('attribute', '*')");
  await frame.locator('#other').click();
  await setSlot(frame, ONERROR);
  await expect.poll(() => violations(frame)).toBeGreaterThanOrEqual(base + 2);
  expect(await heard(page)).not.toContain('attribute');
  expect(await heard(page)).not.toContain('onerror');

  await setHandler(frame, SHIPPED_HANDLER);
  await frame.locator('#other').click();
  await expect.poll(() => heard(page)).toContain('handler');
});

// Chromium's sandbox refuses a javascript: URL in an opaque-origin frame on
// its own, so the frame here is unsandboxed: the policy is the only gate, as
// it may be in a browser whose sandbox lets the URL through.
test('a javascript: URL does not run', async ({ page }) => {
  const frame = await load(page, { sandboxed: false });
  const base = await violations(frame);
  await navigate(frame, JAVASCRIPT_URL);
  await expect.poll(() => violations(frame)).toBe(base + 1);
  expect(await heard(page)).not.toContain('javascript');
});

const unsafeInline = (doc: string) => doc.replace(/script-src [^;]*;/, "script-src 'unsafe-inline';");

test('control: under the policy this replaced, the same probes run', async ({ page }) => {
  const frame = await load(page, { policy: unsafeInline });
  await insertScript(frame, "parent.postMessage('created', '*')");
  await setSlot(frame, ONERROR);
  await writeDocument(frame);
  await expect.poll(() => heard(page)).toEqual(expect.arrayContaining(['created', 'onerror', 'written']));

  const unsandboxed = await load(page, { policy: unsafeInline, sandboxed: false });
  await navigate(unsandboxed, JAVASCRIPT_URL);
  await expect.poll(() => heard(page)).toContain('javascript');
});
