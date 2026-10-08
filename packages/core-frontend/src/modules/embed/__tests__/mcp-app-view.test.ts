import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The MCP App view the backend serves as `ui://hexis/page-<hash>.html`, RUN — not
 * grepped. It lives in core-backend's packaged `mcp-app/` folder, and this
 * package is the one with a DOM to run it in.
 *
 * What is pinned is the half of the extension protocol a host holds us to —
 * the handshake's required fields, and the shape of the tool result the host
 * delivers (the params ARE the CallToolResult) — and the contract between the
 * view and the deployment's embed bundle: where the view finds the bundle,
 * what it hands it, and what it says when the sandbox will not load it.
 */
const PAGE = readFileSync(path.resolve(__dirname, '../../../../../core-backend/mcp-app/page.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*)<\/script>/.exec(PAGE)![1];
const BODY = /<body>([\s\S]*?)<script>/.exec(PAGE)![1];
const STYLE = /<style>([\s\S]*?)<\/style>/.exec(PAGE)![1];

const ORIGIN = 'https://hexis.example';
const APP_URL = `${ORIGIN}/workspace/main/knowledge-base/Data/Thing.md`;

/** A Vite build manifest as the deployment serves it: the SPA entry, the embed entry, a shared chunk. */
const MANIFEST = {
  'index.html': { file: 'assets/index-1a.js', isEntry: true, name: 'main', css: ['assets/index-1a.css'] },
  'src/embed.tsx': {
    file: 'assets/embed-9f.js',
    isEntry: true,
    name: 'embed',
    css: ['assets/embed-9f.css'],
    imports: ['_shared-3c.js'],
  },
  '_shared-3c.js': { file: 'assets/shared-3c.js', css: ['assets/shared-3c.css'] },
};

let host: { postMessage: ReturnType<typeof vi.fn> };
let fetchMock: ReturnType<typeof vi.fn>;
const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
/**
 * The listeners each run of the view's script registers on the one window
 * these tests share. Removed after every test: left in place, every earlier
 * run would answer the next test's messages too, against elements the
 * document no longer holds.
 */
const registered: EventListener[] = [];

type Handoff = { baseUrl: string; token: string; openLink: (url: string) => void };
const handoff = () => (window as unknown as { __HEXIS_EMBED__?: Handoff }).__HEXIS_EMBED__;

beforeEach(() => {
  // The test is about WHAT the view loads, not about loading it.
  const happyDOM = (
    window as {
      happyDOM?: {
        settings: {
          disableIframePageLoading: boolean;
          disableJavaScriptFileLoading: boolean;
          disableCSSFileLoading: boolean;
        };
      };
    }
  ).happyDOM;
  if (happyDOM) {
    happyDOM.settings.disableIframePageLoading = true;
    happyDOM.settings.disableJavaScriptFileLoading = true;
    happyDOM.settings.disableCSSFileLoading = true;
  }
  document.head.innerHTML = `<style>${STYLE}</style>`;
  document.body.innerHTML = BODY;
  host = { postMessage: vi.fn() };
  Object.defineProperty(window, 'parent', { configurable: true, value: host });
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => MANIFEST }));
  vi.stubGlobal('fetch', fetchMock);
  // happy-dom reports every script and stylesheet it was told not to load
  // as a console error; the tests below dispatch the load and error events
  // themselves, so those reports are noise.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'message' && listener) registered.push(listener as EventListener);
    addEventListener(type, listener as EventListener, options);
  });
  new Function(SCRIPT)();
});

afterEach(() => {
  for (const listener of registered.splice(0)) window.removeEventListener('message', listener);
  if (realParent) Object.defineProperty(window, 'parent', realParent);
  else delete (window as { parent?: unknown }).parent;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as unknown as { __HEXIS_EMBED__?: unknown }).__HEXIS_EMBED__;
});

function fromHost(data: unknown) {
  window.dispatchEvent(new MessageEvent('message', { data, source: host as never, origin: 'https://host.example' }));
}

/** A tool result carrying an embed address, as `open_page` answers. */
function pageResult(structuredContent: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    method: 'ui/notifications/tool-result',
    params: {
      content: [{ type: 'text', text: '{}' }],
      structuredContent: { embedUrl: `${ORIGIN}/embed?token=t`, appUrl: APP_URL, ...structuredContent },
    },
  };
}

/** Let the manifest fetch and its continuations run. */
async function settled() {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const sentMethods = () => host.postMessage.mock.calls.map((c) => (c[0] as { method?: string }).method);
const notice = () => document.getElementById('notice')!;
const root = () => document.getElementById('root')!;
const bundleScript = () => document.querySelector('script[type="module"]') as HTMLScriptElement | null;

describe('the MCP App view', () => {
  it('opens with a ui/initialize carrying the app identity and capabilities a host requires', () => {
    const [message] = host.postMessage.mock.calls[0] as [Record<string, unknown>];
    expect(message).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize' });
    const params = message.params as Record<string, unknown>;
    expect(params.protocolVersion).toEqual(expect.any(String));
    expect(params.appInfo).toMatchObject({ name: expect.any(String), version: expect.any(String) });
    expect(params.appCapabilities).toEqual(expect.any(Object));
  });

  it('confirms the handshake with ui/notifications/initialized', () => {
    const { id } = host.postMessage.mock.calls[0][0] as { id: string };
    fromHost({ jsonrpc: '2.0', id, result: { protocolVersion: '2026-01-26' } });
    expect(sentMethods()).toContain('ui/notifications/initialized');
  });

  it('does not confirm a handshake the host rejected', () => {
    const { id } = host.postMessage.mock.calls[0][0] as { id: string };
    fromHost({ jsonrpc: '2.0', id, error: { code: -32600, message: 'unsupported' } });
    expect(sentMethods()).not.toContain('ui/notifications/initialized');
    // And the reader is told, rather than left at "Opening the page…".
    expect(notice().textContent).toBe('The chat app refused to open this page.');
  });

  /**
   * The view frames nothing — a chat host's sandbox forbids it — so the page
   * is drawn by the deployment's own embed bundle, loaded into the view's
   * document. The bundle is found through the deployment's build manifest,
   * its stylesheets first (its own and those of the chunks it imports), and
   * everything comes from the one origin the embed address names.
   */
  it('loads the deployment embed bundle from its build manifest, with every stylesheet it needs', async () => {
    fromHost(pageResult());
    await settled();
    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/embed-manifest.json`, expect.objectContaining({ credentials: 'omit' }));
    expect(bundleScript()?.getAttribute('src')).toBe(`${ORIGIN}/assets/embed-9f.js`);
    const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.getAttribute('href'));
    expect(styles).toEqual([`${ORIGIN}/assets/embed-9f.css`, `${ORIGIN}/assets/shared-3c.css`]);
    // Not the SPA's own entry: that one mounts the whole app.
    expect(bundleScript()?.getAttribute('src')).not.toContain('index-1a');
    expect(document.querySelector('iframe')).toBeNull();
  });

  /**
   * A deployment served under a path prefix has its manifest, its bundle and
   * its API under that prefix — all of which the embed address names, since
   * it is `<public frontend URL>/embed?token=…`.
   */
  it('keeps the path prefix a deployment is served under', async () => {
    fromHost(pageResult({ embedUrl: `${ORIGIN}/hexis/embed?token=t` }));
    await settled();
    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/hexis/embed-manifest.json`, expect.anything());
    expect(bundleScript()?.getAttribute('src')).toBe(`${ORIGIN}/hexis/assets/embed-9f.js`);
    expect(handoff()).toMatchObject({ baseUrl: `${ORIGIN}/hexis`, token: 't' });
  });

  it('shows one page per view: a second tool result does not load a second bundle', async () => {
    fromHost(pageResult());
    fromHost(pageResult({ embedUrl: `${ORIGIN}/embed?token=t2` }));
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('script[type="module"]')).toHaveLength(1);
    expect(handoff()).toMatchObject({ token: 't' });
  });

  it('hands the bundle the token, the deployment address and the host way of opening a link, before it runs', async () => {
    fromHost(pageResult());
    await settled();
    expect(handoff()).toMatchObject({ baseUrl: ORIGIN, token: 't' });
    handoff()!.openLink(`${ORIGIN}/workspace/main/knowledge-base/Other.md`);
    const opened = host.postMessage.mock.calls.map((c) => c[0] as { method?: string; params?: { url?: string } });
    expect(opened.find((m) => m.method === 'ui/open-link')?.params?.url).toBe(
      `${ORIGIN}/workspace/main/knowledge-base/Other.md`,
    );
  });

  it('shows the page once the bundle has run, and the notice until then', async () => {
    fromHost(pageResult());
    await settled();
    // The page's own stylesheet is applied: an id rule giving the root its
    // display must not outrank the class that hides it.
    expect(getComputedStyle(root()).display).toBe('none');
    expect(getComputedStyle(notice()).display).not.toBe('none');
    bundleScript()!.dispatchEvent(new Event('load'));
    expect(getComputedStyle(root()).display).toBe('block');
    expect(getComputedStyle(notice()).display).toBe('none');
  });

  /**
   * A host starts an app view a few lines tall and grows it only when the
   * view asks. The page scrolls inside the view, so the ask is a reading
   * height, sent once the page is on screen — a notice needs no room.
   */
  it('asks the host for a reading height once the page is on screen, and not before', async () => {
    const sizeRequests = () =>
      host.postMessage.mock.calls
        .map((c) => c[0] as { method?: string; params?: { height?: unknown } })
        .filter((m) => m.method === 'ui/notifications/size-changed');
    fromHost(pageResult());
    await settled();
    expect(sizeRequests()).toHaveLength(0);
    bundleScript()!.dispatchEvent(new Event('load'));
    const [ask] = sizeRequests();
    expect(ask).toBeDefined();
    expect(typeof ask.params?.height).toBe('number');
    expect(ask.params!.height as number).toBeGreaterThanOrEqual(480);
  });

  it('asks for no room when there is only a sentence to show', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    fromHost(pageResult());
    await settled();
    expect(sentMethods()).not.toContain('ui/notifications/size-changed');
  });

  it.each([
    ['the manifest cannot be fetched', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
    ['the manifest answers an error', () => fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })],
    [
      'the manifest names no embed entry',
      () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ 'index.html': MANIFEST['index.html'] }) }),
    ],
  ])('says the page could not load and offers the app when %s', async (_label, arrange) => {
    arrange();
    fromHost(pageResult());
    await settled();
    expect(notice().textContent).toContain('did not let the page load');
    const link = notice().querySelector('a')!;
    expect(link.textContent).toBe('Open it in the knowledge base');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const opened = host.postMessage.mock.calls.map((c) => c[0] as { method?: string; params?: { url?: string } });
    expect(opened.find((m) => m.method === 'ui/open-link')?.params?.url).toBe(APP_URL);
    expect(bundleScript()).toBeNull();
  });

  it('says the page could not load when the sandbox refuses the bundle script', async () => {
    fromHost(pageResult());
    await settled();
    bundleScript()!.dispatchEvent(new Event('error'));
    expect(notice().textContent).toContain('did not let the page load');
    expect(getComputedStyle(root()).display).toBe('none');
  });

  it('says why there is no view when the result carries no embed address', () => {
    fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: { note: 'The embedded view needs an https deployment.' } },
    });
    expect(notice().textContent).toContain('needs an https deployment');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getComputedStyle(root()).display).toBe('none');
  });

  it('shows the reason a refused call gave, from its text block', () => {
    fromHost({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { isError: true, content: [{ type: 'text', text: 'File not found: Notes/missing.md' }] },
    });
    expect(notice().textContent).toBe('File not found: Notes/missing.md');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores a message that did not come from the host', async () => {
    window.dispatchEvent(
      new MessageEvent('message', { data: pageResult(), source: null, origin: 'https://elsewhere.example' }),
    );
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handoff()).toBeUndefined();
  });
});
