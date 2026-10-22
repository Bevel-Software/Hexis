import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';
import { buildSandboxedHtml } from '../src/modules/workspace/components/renderers/htmlSandbox';
import type { PageConsent, PageToolsClient, answerToolCall, asToolCall } from '../src/modules/workspace/components/renderers/htmlToolBridge';

/** What the bundled fixture leaves on the host page: the renderer's tool bridge. */
type HostWindow = Window & {
  PageToolsHost: {
    PageConsent: typeof PageConsent;
    PageToolsClient: typeof PageToolsClient;
    answerToolCall: typeof answerToolCall;
    asToolCall: typeof asToolCall;
  };
  posted: Array<{ fn: string; isFile: boolean; isBlob: boolean; name: string | null; size: number; options: unknown }>;
};

/**
 * A page's `uploadFile`, round-tripped through the real intermediaries: the
 * `File` a real `<input type="file">` holds, structured-cloned by a real
 * `postMessage` out of a real sandboxed `srcdoc` frame (opaque origin, as
 * the file page's), answered by the renderer's own bridge code on the host
 * page, and sent by the browser's own `fetch` as the upload's raw body. The
 * unit suite answers each half against a stand-in for the other; this
 * proves what arrives at the upload endpoint is the file the page chose —
 * its name, and bytes with the same SHA-256 — and that the token travels in
 * the header and never into the frame.
 *
 * The server is answered here: the hosted MCP endpoint and the upload
 * endpoint, routed by the test, recording what reached them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ORIGIN = 'https://app.example';
const PAGE_PATH = 'Dashboards/Campaigns.html';
const TOKEN = 'upload-token-the-page-never-sees';

const HOST = `<!doctype html>
<html><body style="margin:0">
<iframe id="f" sandbox="allow-scripts" style="display:block;width:640px;height:200px;border:0"></iframe>
</body></html>`;

let hostBundle: string | null = null;

/** The renderer's tool bridge, bundled for a browser page once per run. */
async function bridgeBundle(): Promise<string> {
  if (hostBundle) return hostBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/page-tools-host.ts'), formats: ['iife'], name: 'PageToolsHostBundle', fileName: () => 'page-tools-host.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the host bundle produced no chunk');
  hostBundle = chunk.code;
  return hostBundle;
}

interface Received {
  tools: Array<{ name: string; arguments: unknown; page: string | undefined }>;
  uploads: Array<{ url: string; token: string | undefined; sha: string; size: number }>;
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

async function host(page: Page) {
  const received: Received = { tools: [], uploads: [] };
  await page.route(`${APP_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: HOST });
    }
    if (url.pathname === '/api/mcp') {
      const rpc = req.postDataJSON() as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      const { name, arguments: args } = rpc.params;
      received.tools.push({ name, arguments: args, page: req.headers()['x-bevel-page'] });
      const body = (args.body ?? {}) as Record<string, unknown>;
      const structuredContent =
        name === 'request_file_upload'
          ? { uploadUrl: `https://hexis.public.example/api/agent/uploads/${TOKEN}`, token: TOKEN }
          : { destination: body.destination, count: 1, total: 1, files: [{ path: `${String(body.destination)}/${received.uploads.at(-1)?.url.split('filename=')[1]}`, outcome: 'created' }] };
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'ok' }], structuredContent } }),
      });
    }
    if (url.pathname === '/api/agent/uploads' && req.method() === 'POST') {
      const bytes = req.postDataBuffer() ?? Buffer.alloc(0);
      received.uploads.push({ url: req.url(), token: req.headers()['x-upload-token'], sha: sha(bytes), size: bytes.length });
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${APP_ORIGIN}/`);
  await page.addScriptTag({ content: await bridgeBundle() });
  // What the renderer does with a frame's message (`HtmlRenderer.tsx`): only
  // from its own frame, parsed by `asToolCall`, answered by `answerToolCall`
  // with the page's client, the reply posted back to that frame. Allow is
  // given, so the upload runs; the card itself is the unit suite's.
  await page.evaluate((pagePath) => {
    const w = window as unknown as HostWindow;
    const frame = document.getElementById('f') as HTMLIFrameElement;
    const client = new w.PageToolsHost.PageToolsClient(pagePath, (input, init) => fetch(input, init));
    const consent = new w.PageToolsHost.PageConsent(() => Promise.resolve(true));
    w.posted = [];
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow) return;
      const call = w.PageToolsHost.asToolCall(event.data);
      if (!call) return;
      const [file, options] = call.args;
      w.posted.push({
        fn: call.fn,
        isFile: file instanceof File,
        isBlob: file instanceof Blob,
        name: file instanceof File ? file.name : null,
        size: file instanceof Blob ? file.size : -1,
        options,
      });
      void w.PageToolsHost.answerToolCall(call, client, consent).then((reply) => frame.contentWindow!.postMessage(reply, '*'));
    });
  }, PAGE_PATH);
  const srcdoc = buildSandboxedHtml({
    title: 'Campaigns',
    libModuleSources: [],
    bodyHtml: '<input id="pick" type="file">',
    toolBridge: true,
  });
  await page.evaluate((doc) => {
    (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc;
  }, srcdoc);
  const frame = page.frameLocator('#f');
  await expect(frame.locator('#pick')).toBeAttached();
  // Everything the frame is ever told, so the test can say the token was never among it.
  await frame.locator('body').evaluate(() => {
    const w = window as unknown as { heard: string[] };
    w.heard = [];
    window.addEventListener('message', (event) => w.heard.push(JSON.stringify(event.data)));
  });
  const posted = () => page.evaluate(() => (window as unknown as HostWindow).posted);
  const heard = () => frame.locator('body').evaluate(() => (window as unknown as { heard: string[] }).heard);
  return { frame, received, posted, heard };
}

test.setTimeout(90_000);

test('a File from the page\'s input arrives at the upload endpoint with its name and its bytes, the token in the header only', async ({ page }) => {
  const h = await host(page);
  const bytes = randomBytes(2 * 1024 * 1024);
  await h.frame.locator('#pick').setInputFiles({
    name: 'Easter plan.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: bytes,
  });

  const answer = await h.frame.locator('#pick').evaluate((input: HTMLInputElement) =>
    (window as unknown as { bevel: { tools: { uploadFile: (f: File, o: unknown) => Promise<unknown> } } }).bevel.tools.uploadFile(
      input.files![0]!,
      { branch: 'main', destination: 'Data/Campaigns/Easter' },
    ),
  );

  // The parent received the File itself, cloned whole by the browser.
  expect(await h.posted()).toEqual([
    {
      fn: 'uploadFile',
      isFile: true,
      isBlob: true,
      name: 'Easter plan.xlsx',
      size: bytes.length,
      options: { branch: 'main', destination: 'Data/Campaigns/Easter' },
    },
  ]);
  // The three steps, in order, as the page; the endpoint got the very bytes chosen.
  expect(h.received.tools.map((t) => t.name)).toEqual(['request_file_upload', 'apply_file_upload']);
  expect(h.received.tools.every((t) => t.page === encodeURIComponent(PAGE_PATH))).toBe(true);
  expect(h.received.tools[1]!.arguments).toEqual({
    body: { branch: 'main', token: TOKEN, destination: 'Data/Campaigns/Easter', all: true },
  });
  expect(h.received.uploads).toHaveLength(1);
  const upload = h.received.uploads[0]!;
  expect(upload.sha).toBe(sha(bytes));
  expect(upload.size).toBe(bytes.length);
  expect(upload.token).toBe(TOKEN);
  expect(upload.url).toBe(`${APP_ORIGIN}/api/agent/uploads?filename=${encodeURIComponent('Easter plan.xlsx')}`);
  expect(upload.url).not.toContain(TOKEN);
  // The page got the apply's answer, and never the token.
  expect(answer).toEqual({
    destination: 'Data/Campaigns/Easter',
    count: 1,
    total: 1,
    files: [{ path: `Data/Campaigns/Easter/${encodeURIComponent('Easter plan.xlsx')}`, outcome: 'created' }],
  });
  const heard = await h.heard();
  expect(heard.length).toBeGreaterThan(0);
  expect(heard.join('\n')).not.toContain(TOKEN);
});

test('a Blob built in the page, with a `name` option, arrives under that name with its bytes', async ({ page }) => {
  const h = await host(page);
  const answer = await h.frame.locator('body').evaluate(() => {
    const data = new Uint8Array(300_000);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + 7) % 256;
    return (window as unknown as { bevel: { tools: { uploadFile: (f: Blob, o: unknown) => Promise<unknown> } } }).bevel.tools.uploadFile(
      new Blob([data], { type: 'text/csv' }),
      { branch: 'main', destination: 'Data/Exports', name: 'rows.csv', mode: 'overwrite' },
    );
  });
  const expected = Buffer.alloc(300_000);
  for (let i = 0; i < expected.length; i += 1) expected[i] = (i * 31 + 7) % 256;

  expect(await h.posted()).toEqual([
    {
      fn: 'uploadFile',
      isFile: false,
      isBlob: true,
      name: null,
      size: expected.length,
      options: { branch: 'main', destination: 'Data/Exports', name: 'rows.csv', mode: 'overwrite' },
    },
  ]);
  expect(h.received.uploads).toHaveLength(1);
  expect(h.received.uploads[0]!.sha).toBe(sha(expected));
  expect(h.received.uploads[0]!.url).toBe(`${APP_ORIGIN}/api/agent/uploads?filename=rows.csv`);
  expect(h.received.tools[1]!.arguments).toEqual({
    body: { branch: 'main', token: TOKEN, destination: 'Data/Exports', all: true, mode: 'overwrite' },
  });
  expect((answer as { count: number }).count).toBe(1);
});
