import { expect, test, type Frame, type Page } from '@playwright/test';
import { buildSandboxedHtml } from '../src/modules/workspace/components/renderers/htmlSandbox';

/**
 * The HTML frame's height, round-tripped through the real browser.
 *
 * The frame's runtime (`htmlSandbox.ts`, `HEIGHT_BRIDGE`) measures the page
 * and posts `bevel.height`; the renderer (`HtmlRenderer.tsx`) sets the
 * frame's content box to it where the host grows with the page. The two
 * are a pair written by one hand across a boundary owned by the browser —
 * layout, a sandboxed `srcdoc` frame, `postMessage` — and the unit suites
 * cross only stand-ins for it. This suite crosses the real thing: the real
 * runtime in a real sandboxed frame, each report applied to the frame
 * exactly as the renderer applies it, and the assertion read off the
 * frame's own document afterwards — the page is shown whole, the frame is
 * no taller than the page, and the pair settles instead of chasing itself.
 */

/** The renderer's floor for a frame whose host grows with the page (`min-h-60`). */
const FLOOR = 240;

/**
 * The host page, standing in for the renderer: one sandboxed frame, sized
 * the way `HtmlRenderer` sizes it where the host grows with the content —
 * the content box set to every `bevel.height` the frame posts, a border,
 * the floor — and every report kept for the assertions.
 */
const HOST = `<!doctype html>
<html><body style="margin:0">
<iframe id="f" sandbox="allow-scripts" style="display:block;width:640px;min-height:${FLOOR}px;box-sizing:content-box;border:1px solid #000"></iframe>
<script>
  window.reports = [];
  window.addEventListener('message', (event) => {
    const frame = document.getElementById('f');
    if (event.source !== frame.contentWindow) return;
    const data = event.data;
    if (!data || data.type !== 'bevel.height' || typeof data.height !== 'number') return;
    window.reports.push(data.height);
    frame.style.height = data.height + 'px';
  });
</script>
</body></html>`;

interface Host {
  page: Page;
  /** The sandboxed frame's own document. */
  frame: () => Frame;
  /** Every height the frame has posted so far. */
  reports: () => Promise<number[]>;
  /** The reports once nothing new has arrived for a while. */
  settled: () => Promise<number[]>;
  /** The frame element's inner height — what the page gets to draw in. */
  frameHeight: () => Promise<number>;
}

/**
 * Load `bodyHtml` as the knowledge-base page, through the real sandbox build.
 * The body goes in as written: the sanitizer that precedes the build in the
 * renderer parses with the browser's `DOMParser`, which this runner (Node)
 * has not, and it is not what is under test here — the runtime the build
 * injects is. Every body below is the test's own.
 */
async function load(page: Page, bodyHtml: string, opts: { frameHeight?: number } = {}): Promise<Host> {
  await page.setContent(HOST);
  if (opts.frameHeight !== undefined) {
    await page.evaluate((h) => {
      document.getElementById('f')!.style.height = `${h}px`;
    }, opts.frameHeight);
  }
  const srcdoc = buildSandboxedHtml({ title: 'page', libModuleSources: [], bodyHtml });
  await page.evaluate((doc) => {
    (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc;
  }, srcdoc);
  const reports = () => page.evaluate(() => (window as unknown as { reports: number[] }).reports.slice());
  await expect.poll(async () => (await reports()).length, { timeout: 10_000 }).toBeGreaterThan(0);
  return {
    page,
    frame: () => {
      const frame = page.frames().find((f) => f.parentFrame() === page.mainFrame());
      if (!frame) throw new Error('the sandboxed frame is not there');
      return frame;
    },
    reports,
    settled: async () => {
      let last = (await reports()).length;
      for (;;) {
        await page.waitForTimeout(300);
        const now = (await reports()).length;
        if (now === last) return reports();
        last = now;
      }
    },
    frameHeight: () => page.evaluate(() => document.getElementById('f')!.clientHeight),
  };
}

/** How far the page overflows the frame it was given: 0 when it is shown whole. */
async function overflow(host: Host): Promise<number> {
  return host.frame().evaluate(() => {
    const doc = document.documentElement;
    return Math.max(0, doc.scrollHeight - doc.clientHeight);
  });
}

/** The lowest edge of the page's content, measured by the test itself, as the browser lays it out. */
async function contentBottom(host: Host): Promise<number> {
  return host.frame().evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    return Math.ceil(range.getBoundingClientRect().bottom + window.pageYOffset);
  });
}

test.describe('an HTML page in a frame whose host grows with the content', () => {
  test('reports the height the browser laid the page out at, and the frame sized to it shows the page whole, once', async ({ page }) => {
    const host = await load(page, '<div style="height:1000px;background:#eee">tall</div>');
    const reports = await host.settled();
    // One value, posted once: the frame sized to the report measures the
    // same page again and says nothing twice.
    expect(new Set(reports).size).toBe(1);
    const [height] = reports;
    expect(height).toBeGreaterThanOrEqual(1000);
    expect(height).toBeLessThanOrEqual(1000 + 32);
    expect(height).toBeGreaterThanOrEqual(await contentBottom(host));
    // The content box took the report: the page's own viewport is the
    // height it asked for, the border is not taken out of it, and nothing
    // scrolls inside the frame.
    expect(await host.frameHeight()).toBe(height);
    expect(await overflow(host)).toBe(0);
  });

  test('a page shorter than its frame reports its own height, not the frame\'s, and the frame comes down to it', async ({ page }) => {
    const host = await load(page, '<div style="height:200px">short</div>', { frameHeight: 900 });
    const reports = await host.settled();
    const height = reports[reports.length - 1]!;
    expect(height).toBeLessThan(400);
    expect(height).toBeGreaterThanOrEqual(200);
    // Not the 900 the frame was given, and the frame follows the page down
    // — to the floor, which is the least a frame here is.
    expect(await host.frameHeight()).toBe(Math.max(height, FLOOR));
    expect(await overflow(host)).toBe(0);
  });

  test('a page that grows reports more, one that shrinks back reports less, and each time the frame fits', async ({ page }) => {
    const host = await load(page, '<div id="top" style="height:300px">top</div>');
    const [first] = await host.settled();
    await host.frame().evaluate(() => {
      const more = document.createElement('div');
      more.id = 'more';
      more.style.height = '600px';
      document.body.appendChild(more);
    });
    await expect.poll(async () => (await host.reports()).length).toBeGreaterThan(1);
    const grown = await host.settled();
    const taller = grown[grown.length - 1]!;
    expect(taller - first!).toBeGreaterThanOrEqual(598);
    expect(taller - first!).toBeLessThanOrEqual(602);
    expect(await overflow(host)).toBe(0);

    await host.frame().evaluate(() => document.getElementById('more')!.remove());
    await expect.poll(async () => (await host.reports()).length).toBeGreaterThan(grown.length);
    const shrunk = await host.settled();
    expect(Math.abs(shrunk[shrunk.length - 1]! - first!)).toBeLessThanOrEqual(1);
  });

  test('text written straight into the body is measured, though the body\'s only element is the runtime\'s script', async ({ page }) => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const host = await load(page, words);
    const reports = await host.settled();
    const height = reports[reports.length - 1]!;
    // Nine hundred words at 640px wide run well past the floor; the report
    // is the text's own extent, and the frame sized to it shows all of it.
    expect(height).toBeGreaterThan(FLOOR);
    expect(height).toBeGreaterThanOrEqual(await contentBottom(host));
    expect(await overflow(host)).toBe(0);
  });

  test('a page sized to its viewport settles at its content instead of chasing the frame', async ({ page }) => {
    const host = await load(
      page,
      '<style>html, body { height: 100%; margin: 0; }</style><div style="height:300px">fills</div>',
    );
    const reports = await host.settled();
    // At most one correction after the first report, and it ends at the
    // content's height: never a report per border's worth, never a collapse.
    expect(reports.length).toBeLessThanOrEqual(2);
    const final = reports[reports.length - 1]!;
    expect(final).toBeGreaterThanOrEqual(300);
    expect(final).toBeLessThanOrEqual(302);
    expect(await host.frameHeight()).toBe(final);
    expect(await overflow(host)).toBe(0);
  });
});
