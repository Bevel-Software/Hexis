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
  /** The host's current document identity — what the controller's layout effect flips on a view change. */
  currentId: string;
  /** Every message the frame's window delivered, as the browser handed it over. */
  arrived: Array<{ type: string; documentId: unknown; requestId: string }>;
  /** Messages the host has not decided yet: a call still in flight when the view changes. */
  held: Array<{ data: unknown; from: string }>;
  /** What the host decided for each held message once released. */
  decided: Array<{ requestId: string; outcome: 'answered' | 'dropped' }>;
};

/**
 * A document's identity, round-tripped through the real intermediaries: the
 * identity `buildSandboxedHtml` builds into a real sandboxed `srcdoc` frame
 * (opaque origin, as the file page's), stamped by the frame's own runtime on
 * what a real `postMessage` carries to the host, parsed by the renderer's own
 * `asToolCall` and answered by its own `answerToolCall`. Then the case the
 * controller exists for: a call the old document made is still in flight
 * when the host replaces the document in the SAME frame — the browser keeps
 * the frame's window — and the host, applying the controller's rule
 * (answer only the current identity), drops it while answering the new
 * document's own call. The unit suite stamps messages by hand against a
 * stub window; this is the browser doing it.
 *
 * The server is answered here: the hosted MCP endpoint, recording what it
 * was asked.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_ORIGIN = 'https://app.example';
const PAGE_PATH = 'Dashboards/Board.html';

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

/** A page whose script calls a tool and requireTools on a click, and keeps what each answered. */
const PAGE_BODY = `
<button id="call">call</button>
<button id="require">require</button>
<pre id="out"></pre>
<script>
  const out = document.getElementById('out');
  const say = (s) => { out.textContent += s + '\\n'; };
  document.getElementById('call').addEventListener('click', () => {
    window.bevel.tools.callTool('read_file', { body: { path: 'a.md' } })
      .then((r) => say('call:ok:' + JSON.stringify(r)), (e) => say('call:err:' + e.code));
  });
  document.getElementById('require').addEventListener('click', () => {
    window.bevel.requireTools().then((r) => say('require:' + r));
  });
</script>`;

async function host(page: Page) {
  const asked: string[] = [];
  await page.route(`${APP_ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: HOST });
    }
    if (url.pathname === '/api/agent/utcp') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: [{ name: 'read_file', tags: [] }] }) });
    }
    if (url.pathname === '/api/mcp') {
      const rpc = req.postDataJSON() as { id: number; params: { name: string } };
      asked.push(rpc.params.name);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ran: rpc.params.name }) }] } }),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${APP_ORIGIN}/`);
  await page.addScriptTag({ content: await bridgeBundle() });
  // The controller's rule, on the host page, over real messages: record what
  // arrived, hold it until the test releases it, and when released answer it
  // only if its identity is still the current one — exactly `useHtmlToolBridge`'s
  // check — through the renderer's own parsing and answering.
  await page.evaluate((pagePath) => {
    const w = window as unknown as HostWindow;
    const frame = document.getElementById('f') as HTMLIFrameElement;
    const client = new w.PageToolsHost.PageToolsClient(pagePath, (input, init) => fetch(input, init));
    const consent = new w.PageToolsHost.PageConsent(() => Promise.resolve(true));
    w.arrived = [];
    w.held = [];
    w.decided = [];
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data as { type?: unknown; documentId?: unknown; requestId?: unknown };
      if (data?.type !== 'bevel.tool.call' && data?.type !== 'bevel.tools.require') return;
      w.arrived.push({ type: String(data.type), documentId: data.documentId, requestId: String(data.requestId) });
      w.held.push({ data, from: String(data.documentId) });
    });
    (w as unknown as { release: () => Promise<void> }).release = async () => {
      const batch = w.held.splice(0);
      for (const { data } of batch) {
        const d = data as { type: string; documentId?: string; requestId: string };
        const asked = w.currentId;
        if (d.documentId !== asked) {
          w.decided.push({ requestId: d.requestId, outcome: 'dropped' });
          continue;
        }
        const reply = (message: unknown) => {
          if (w.currentId === asked) frame.contentWindow!.postMessage(message, '*');
        };
        if (d.type === 'bevel.tools.require') {
          reply({ type: 'bevel.tools.require.response', requestId: d.requestId, ok: true, result: true });
          w.decided.push({ requestId: d.requestId, outcome: 'answered' });
          continue;
        }
        const call = w.PageToolsHost.asToolCall(d);
        if (!call) continue;
        reply(await w.PageToolsHost.answerToolCall(call, client, consent));
        w.decided.push({ requestId: d.requestId, outcome: 'answered' });
      }
    };
  }, PAGE_PATH);

  /** Put a document with `documentId` in the frame, as a view change does, and make it the host's current one. */
  const show = async (documentId: string) => {
    // The document names itself in its body, so the test waits for THIS
    // document and never clicks in the one it is replacing.
    const srcdoc = buildSandboxedHtml({
      title: 'Board',
      libModuleSources: [],
      bodyHtml: `${PAGE_BODY}<span id="who">${documentId}</span>`,
      toolBridge: { documentId },
    });
    await page.evaluate(
      ([doc, id]) => {
        (window as unknown as HostWindow).currentId = id!;
        (document.getElementById('f') as HTMLIFrameElement).srcdoc = doc!;
      },
      [srcdoc, documentId],
    );
    await expect(page.frameLocator('#f').locator('#who')).toHaveText(documentId);
  };
  const frame = page.frameLocator('#f');
  const arrived = () => page.evaluate(() => (window as unknown as HostWindow).arrived);
  const decided = () => page.evaluate(() => (window as unknown as HostWindow).decided);
  const release = () => page.evaluate(() => (window as unknown as { release: () => Promise<void> }).release());
  const said = () => frame.locator('#out').evaluate((el) => el.textContent ?? '');
  return { frame, asked, show, arrived, decided, release, said };
}

test.setTimeout(90_000);

test('the frame\'s runtime stamps the identity the host built it with on what a real postMessage carries, and the reply comes back to the page', async ({ page }) => {
  const h = await host(page);
  await h.show('doc-one');
  await h.frame.locator('#call').click();
  await h.frame.locator('#require').click();
  await expect.poll(async () => (await h.arrived()).length).toBe(2);
  const arrived = await h.arrived();
  expect(arrived.map((m) => [m.type, m.documentId])).toEqual([
    ['bevel.tool.call', 'doc-one'],
    ['bevel.tools.require', 'doc-one'],
  ]);
  await h.release();
  await expect.poll(() => h.said()).toContain('call:ok:{"ran":"read_file"}');
  await expect.poll(() => h.said()).toContain('require:true');
  expect(h.asked).toEqual(['read_file']);
});

test('a call the replaced document made, decided after the view changed in the same frame, is dropped; the new document\'s own call is answered', async ({ page }) => {
  const h = await host(page);
  await h.show('doc-one');
  await h.frame.locator('#call').click();
  await expect.poll(async () => (await h.arrived()).length).toBe(1);
  // The view changes while that call is undecided: a new document in the
  // SAME frame element — the browser keeps the frame's window — with its own
  // identity, which is now the host's current one.
  await h.show('doc-two');
  await h.frame.locator('#call').click();
  await expect.poll(async () => (await h.arrived()).length).toBe(2);
  expect((await h.arrived()).map((m) => m.documentId)).toEqual(['doc-one', 'doc-two']);

  await h.release();
  expect(await h.decided()).toEqual([
    { requestId: (await h.arrived())[0]!.requestId, outcome: 'dropped' },
    { requestId: (await h.arrived())[1]!.requestId, outcome: 'answered' },
  ]);
  // The server ran only the new document's call, and only the new document heard an answer.
  expect(h.asked).toEqual(['read_file']);
  await expect.poll(() => h.said()).toContain('call:ok:{"ran":"read_file"}');
  expect((await h.said()).match(/call:/g)).toHaveLength(1);
});
