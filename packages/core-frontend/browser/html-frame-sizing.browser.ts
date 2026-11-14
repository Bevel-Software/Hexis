import { expect, test, type Page } from '@playwright/test';
import { buildSandboxedHtml } from '../src/modules/workspace/components/renderers/htmlSandbox';
import { attachFrameResizeHandle } from '../src/modules/workspace/components/renderers/frameResizeHandle';

/**
 * The handle under an HTML page's frame, driven by a real pointer in a real
 * browser, over a real sandboxed `srcdoc` frame.
 *
 * The one thing a stand-in document cannot answer: a frame is its own
 * document, and the moment a drag crosses into it the frame would take every
 * pointer event from then on — unless the handle captured the pointer. The
 * unit suite proves the handle's arithmetic; this proves the capture, with
 * the handle's own code (`attachFrameResizeHandle`, loaded into the page
 * from its source — it closes over nothing) and the renderer's rule for the
 * frame while a drag lasts (no pointer events), applied as the renderer
 * applies them.
 */

const STANDARD = 480;
const MIN = 160;
const MAX = 2400;

/** A host page standing in for the renderer: the frame, the handle, and the renderer's rules. */
const HOST = `<!doctype html>
<html><body style="margin:0">
<iframe id="f" sandbox="allow-scripts" style="display:block;width:640px;height:${STANDARD}px;box-sizing:content-box;border:1px solid #000"></iframe>
<div id="h" role="separator" tabindex="0" style="height:8px;margin-top:4px;background:#ccc;cursor:row-resize"></div>
<script>
  window.settled = [];
  window.ready = (attach) => {
    const frame = document.getElementById('f');
    const handle = document.getElementById('h');
    attach(handle, {
      current: () => parseInt(frame.style.height, 10),
      apply: (height) => {
        frame.style.height = height + 'px';
        frame.style.pointerEvents = 'none';
      },
      settle: (height) => {
        frame.style.height = height + 'px';
        frame.style.pointerEvents = '';
        window.settled.push(height);
      },
      min: ${MIN},
      max: ${MAX},
      step: 24,
    });
  };
</script>
</body></html>`;

async function host(page: Page) {
  await page.setContent(HOST);
  const srcdoc = buildSandboxedHtml({
    title: 'page',
    libModuleSources: [],
    bodyHtml: '<div style="height:2000px;background:linear-gradient(#eee,#999)">a long page</div>',
  });
  await page.evaluate((doc) => {
    (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc;
  }, srcdoc);
  // The handle's own code, as the browser sees it after the test runner's
  // transform; it closes over nothing, so its source is all of it.
  await page.addScriptTag({ content: `window.ready(${attachFrameResizeHandle.toString()});` });
  const frameHeight = () => page.evaluate(() => (document.getElementById('f') as HTMLIFrameElement).clientHeight);
  const settled = () => page.evaluate(() => (window as unknown as { settled: number[] }).settled.slice());
  const handleBox = async () => (await page.locator('#h').boundingBox())!;
  return { frameHeight, settled, handleBox };
}

test('a drag that crosses into the frame keeps resizing it: the handle holds the pointer', async ({ page }) => {
  const h = await host(page);
  expect(await h.frameHeight()).toBe(STANDARD);
  const box = await h.handleBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // Down on the handle, then up across the frame — the pointer is over the
  // frame's document for the rest of the drag.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 100, { steps: 5 });
  expect(await h.frameHeight()).toBe(STANDARD - 100);
  await page.mouse.move(x, y - 250, { steps: 5 });
  expect(await h.frameHeight()).toBe(STANDARD - 250);
  // Nothing settled yet: the reader is still dragging.
  expect(await h.settled()).toEqual([]);
  await page.mouse.up();
  expect(await h.settled()).toEqual([STANDARD - 250]);
  expect(await h.frameHeight()).toBe(STANDARD - 250);

  // And taller again, past where it started.
  const again = await h.handleBox();
  await page.mouse.move(again.x + 10, again.y + again.height / 2);
  await page.mouse.down();
  await page.mouse.move(again.x + 10, again.y + again.height / 2 + 400, { steps: 8 });
  await page.mouse.up();
  expect(await h.frameHeight()).toBe(STANDARD - 250 + 400);
  expect(await h.settled()).toEqual([STANDARD - 250, STANDARD + 150]);
});

test('never shorter than the least nor taller than the most, the keys nudge it, and the handle declines the browser\'s touch gestures', async ({ page }) => {
  const h = await host(page);
  // What is checked here is the declaration: the browser's own touch
  // gestures are off on the handle (`touch-action: none`), which is what
  // keeps a finger's drag from reading as a scroll of the page and being
  // cancelled. The drags below are a mouse's; a finger's is not driven here.
  expect(await page.locator('#h').evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  await page.setViewportSize({ width: 800, height: 3200 });
  const tall = await h.handleBox();
  await page.mouse.move(tall.x + 5, tall.y + 2);
  await page.mouse.down();
  await page.mouse.move(tall.x + 5, 3100, { steps: 6 });
  await page.mouse.up();
  expect(await h.frameHeight()).toBe(MAX);
  const box = await h.handleBox();
  await page.mouse.move(box.x + 5, box.y + 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, 0, { steps: 4 });
  await page.mouse.up();
  expect(await h.frameHeight()).toBe(MIN);

  await page.locator('#h').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await h.frameHeight()).toBe(MIN + 48);
  await page.keyboard.press('ArrowUp');
  expect(await h.frameHeight()).toBe(MIN + 24);
  expect(await h.settled()).toEqual([MAX, MIN, MIN + 24, MIN + 48, MIN + 24]);
});
