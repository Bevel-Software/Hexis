import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';
import type { AppBridge, McpUiHostCapabilities, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';

/** What the bundled fixture leaves on the host page: the SDK's bridge and its transport. */
type McpHostWindow = Window & {
  McpHost: { AppBridge: typeof AppBridge; PostMessageTransport: typeof PostMessageTransport };
  calls: unknown[];
  sized: number[];
  markReady: () => void;
};

/**
 * The chat view renewing its token, round-tripped through a real MCP Apps
 * host: the SDK's own `AppBridge` on the parent page, over a real
 * `postMessage` boundary, with the view as core-backend ships it in an
 * iframe below. The unit suite answers the view's half against a stand-in
 * host; this proves the two halves meet — the handshake the bridge
 * validates, the tool result it delivers, and the `tools/call` the view
 * sends it for `open_page`, answered by the bridge and read back by the
 * bundle the view loaded.
 *
 * The host is the SDK as published (`@modelcontextprotocol/ext-apps`),
 * bundled for the page by this test; nothing of ours stands in for it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEW = readFileSync(path.resolve(here, '../../core-backend/mcp-app/page.html'), 'utf8');
/**
 * Where the host page is served from. A real origin, not `about:blank`: the
 * view answers its host at the origin the handshake's reply came from, and
 * an opaque origin ("null") is no address to post to — a chat host has a
 * real one, and so does this one.
 */
const HOST_ORIGIN = 'https://chat.example';
const DEPLOYMENT = 'https://hexis.example';
const PAGE_PATH = 'knowledge-base/Data/Thing.md';

/** A Vite build manifest as the deployment serves it: the embed entry and its stylesheet. */
const MANIFEST = {
  'src/embed.tsx': { file: 'assets/embed.js', isEntry: true, name: 'embed', css: ['assets/embed.css'] },
};

/**
 * What stands in for the deployment's embed bundle: the one thing the real
 * bundle does that this test is about — take the handoff the view left for
 * it, ask for a renewal, and show what came back.
 */
const BUNDLE = `
const handoff = window.__HEXIS_EMBED__;
const root = document.getElementById('root');
root.textContent = 'token:' + handoff.token;
window.renewNow = () => handoff.renew().then((token) => {
  root.textContent = 'renewed:' + token + ' handoff:' + handoff.token;
});
`;

/** The host page: an iframe for the view, and the SDK's bridge once its bundle has loaded. */
const HOST = `<!doctype html>
<html><body style="margin:0">
<iframe id="view" style="display:block;width:640px;height:200px;border:0"></iframe>
<script>
  window.calls = [];
  window.sized = [];
  window.ready = new Promise((resolve) => { window.markReady = resolve; });
</script>
</body></html>`;

let hostBundle: string | null = null;

/** The SDK's bridge, bundled for a browser page once per run. */
async function bridgeBundle(): Promise<string> {
  if (hostBundle) return hostBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/mcp-host.ts'), formats: ['iife'], name: 'McpHostBundle', fileName: () => 'mcp-host.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  // One output per format asked for; one format was asked for.
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the host bundle produced no chunk');
  hostBundle = chunk.code;
  return hostBundle;
}

interface HostOptions {
  /** What the bridge tells the view it can do; `serverTools` is what the view reads. */
  capabilities: McpUiHostCapabilities;
  /** What the host answers a `tools/call` with — or refuses, by throwing. */
  answer: string;
}

async function host(page: Page, options: HostOptions) {
  // The deployment, as the view and its bundle reach it: the manifest, the
  // bundle, its stylesheet — all answered here, with the CORS the view's
  // cross-origin loads need.
  await page.route(`${DEPLOYMENT}/**`, async (route) => {
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    if (url.pathname === '/embed-manifest.json') {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(MANIFEST) });
    }
    if (url.pathname === '/assets/embed.js') {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/javascript' }, body: BUNDLE });
    }
    if (url.pathname === '/assets/embed.css') {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/css' }, body: '' });
    }
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
  await page.route(`${HOST_ORIGIN}/`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: HOST }));
  await page.goto(`${HOST_ORIGIN}/`);
  await page.addScriptTag({ content: await bridgeBundle() });
  // The bridge, attached to the view's window before the view exists, so its
  // handshake is answered by the SDK and not lost.
  await page.evaluate(
    ({ capabilities, answer, deployment, pagePath }) => {
      const frame = document.getElementById('view') as HTMLIFrameElement;
      const w = window as unknown as McpHostWindow;
      const bridge = new w.McpHost.AppBridge(null, { name: 'test-host', version: '1.0.0' }, capabilities);
      bridge.oncalltool = async (params) => {
        w.calls.push(params);
        if (answer === 'refuse') throw new Error('the host runs no tools for a view');
        return {
          content: [{ type: 'text', text: 'the page' }],
          structuredContent: { embedUrl: `${deployment}/embed?token=${answer}`, path: pagePath },
        };
      };
      bridge.onsizechange = (params) => {
        w.sized.push(params.height as number);
      };
      bridge.oninitialized = () => {
        void bridge.sendToolResult({
          content: [{ type: 'text', text: 'the page' }],
          structuredContent: { embedUrl: `${deployment}/embed?token=t1`, path: pagePath, heading: 'intro' },
        });
        w.markReady();
      };
      const transport = new w.McpHost.PostMessageTransport(frame.contentWindow!, frame.contentWindow!);
      void bridge.connect(transport);
    },
    { capabilities: options.capabilities, answer: options.answer, deployment: DEPLOYMENT, pagePath: PAGE_PATH },
  );
  // The view, as shipped. `srcdoc` keeps it on the host's origin, which is
  // where a chat host's sandbox puts it too.
  await page.evaluate((doc) => {
    (document.getElementById('view') as HTMLIFrameElement).srcdoc = doc;
  }, VIEW);
  await page.evaluate(() => (window as unknown as { ready: Promise<void> }).ready);
  const view = page.frameLocator('#view');
  const calls = () => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);
  const sized = () => page.evaluate(() => (window as unknown as { sized: number[] }).sized);
  const renewNow = () => view.locator('body').evaluate(() => (window as unknown as { renewNow: () => Promise<void> }).renewNow());
  return { view, calls, sized, renewNow };
}

test.setTimeout(90_000);

test('renews its token through the host: the bridge answers open_page and the bundle reads the fresh token', async ({ page }) => {
  const h = await host(page, { capabilities: { serverTools: {} }, answer: 't2' });
  // The bridge delivered the tool result and the view loaded the bundle,
  // which read the handoff's token; the view then asked for a reading height.
  await expect(h.view.locator('#root')).toHaveText('token:t1');
  await expect.poll(h.sized).toEqual([640]);

  await h.renewNow();
  await expect(h.view.locator('#root')).toHaveText('renewed:t2 handoff:t2');
  // What the bridge received: `open_page`, with the arguments under `body`
  // as every Hexis tool takes them, for the path and heading the result echoed.
  expect(await h.calls()).toEqual([
    { name: 'open_page', arguments: { body: { path: PAGE_PATH, heading: 'intro' } } },
  ]);
});

test('takes a refusal from the host as no token, and does not ask again', async ({ page }) => {
  const h = await host(page, { capabilities: {}, answer: 'refuse' });
  await expect(h.view.locator('#root')).toHaveText('token:t1');
  await h.renewNow();
  await expect(h.view.locator('#root')).toHaveText('renewed:null handoff:t1');
  await h.renewNow();
  await expect(h.view.locator('#root')).toHaveText('renewed:null handoff:t1');
  // Asked once; a host that said nothing about server tools and refused has answered.
  expect(await h.calls()).toHaveLength(1);
});
