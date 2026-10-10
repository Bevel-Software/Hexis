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

type Handoff = {
  baseUrl: string;
  token: string;
  openLink: (url: string) => void;
  renew: () => Promise<string | null>;
};
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

  /**
   * The extension gives a view no way to say it CALLS server tools —
   * `appCapabilities.tools` would mean the view exposes tools of its own — so
   * the view declares nothing and reads the host's `serverTools` instead.
   */
  it('declares no capabilities of its own at ui/initialize', () => {
    const [message] = host.postMessage.mock.calls[0] as [{ params: { appCapabilities: unknown } }];
    expect(message.params.appCapabilities).toEqual({});
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
    // The one height the view asks for, pinned: a document pane's reading
    // height, and the number the changeset documents.
    expect(sizeRequests()).toEqual([
      { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 640 } },
    ]);
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

/**
 * The token `open_page` mints lives minutes. When the bundle's call is
 * refused for it, the bundle calls the `renew` the view handed it, and the
 * view asks its host to call `open_page` again — `tools/call`, app to host,
 * over the chat's own connection and so as its identity — for the same path
 * and heading, and takes the token out of the `embedUrl` it answers.
 */
describe('the MCP App view renewing its token', () => {
  /** The view's handshake, answered with the host capabilities given. */
  function handshake(hostCapabilities?: Record<string, unknown>) {
    const { id } = host.postMessage.mock.calls[0][0] as { id: string };
    fromHost({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2026-01-26', ...(hostCapabilities ? { hostCapabilities } : {}) },
    });
  }

  /** The `tools/call` requests the view sent its host. */
  const toolCalls = () =>
    host.postMessage.mock.calls
      .map((c) => c[0] as { id?: string; method?: string; params?: { name?: string; arguments?: unknown } })
      .filter((m) => m.method === 'tools/call');

  async function opened(structuredContent: Record<string, unknown> = { path: 'Data/Thing.md' }) {
    fromHost(pageResult(structuredContent));
    await settled();
    return handoff()!;
  }

  it('asks the host to call open_page for its own path and heading, and takes the fresh token', async () => {
    handshake({ serverTools: {} });
    const page = await opened({ path: 'knowledge-base/Data/Thing.md', heading: 'what-it-is' });
    const renewed = page.renew();
    const [call] = toolCalls();
    expect(call).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      // Under `body`, as every Hexis tool takes its arguments over `/api/mcp`:
      // flat ones are refused there and no token comes back.
      params: {
        name: 'open_page',
        arguments: { body: { path: 'knowledge-base/Data/Thing.md', heading: 'what-it-is' } },
      },
    });
    fromHost({
      jsonrpc: '2.0',
      id: call.id,
      result: { structuredContent: { embedUrl: `${ORIGIN}/embed?token=t2`, appUrl: APP_URL } },
    });
    await expect(renewed).resolves.toBe('t2');
    // The handoff follows, so whatever reads it next reads the fresh token.
    expect(handoff()!.token).toBe('t2');
  });

  it('asks with the path alone when the view was not opened at a heading', async () => {
    handshake({ serverTools: {} });
    const page = await opened({ path: 'Data/Thing.md' });
    void page.renew();
    expect(toolCalls()[0].params?.arguments).toEqual({ body: { path: 'Data/Thing.md' } });
  });

  it('shares one call between renewals asked for together', async () => {
    handshake({ serverTools: {} });
    const page = await opened();
    const first = page.renew();
    const second = page.renew();
    expect(toolCalls()).toHaveLength(1);
    fromHost({ jsonrpc: '2.0', id: toolCalls()[0].id, result: { structuredContent: { embedUrl: `${ORIGIN}/embed?token=t2` } } });
    await expect(first).resolves.toBe('t2');
    await expect(second).resolves.toBe('t2');
  });

  it('does not ask a host that said it runs no server tools for a view', async () => {
    handshake({ openLinks: {} });
    const page = await opened();
    await expect(page.renew()).resolves.toBeNull();
    expect(toolCalls()).toHaveLength(0);
  });

  /** A host that said nothing either way is asked once; a refusal is its answer. */
  it('asks a host that said nothing once, and takes a refusal as its answer', async () => {
    handshake();
    const page = await opened();
    const renewed = page.renew();
    expect(toolCalls()).toHaveLength(1);
    fromHost({ jsonrpc: '2.0', id: toolCalls()[0].id, error: { code: -32601, message: 'Method not found' } });
    await expect(renewed).resolves.toBeNull();
    await expect(page.renew()).resolves.toBeNull();
    expect(toolCalls()).toHaveLength(1);
  });

  /**
   * `open_page`'s own gate decides: a reader whose access was withdrawn is
   * refused exactly as on a first call, and the view gets no token.
   */
  it('gets no token when open_page refuses the call', async () => {
    handshake({ serverTools: {} });
    const page = await opened();
    const renewed = page.renew();
    fromHost({
      jsonrpc: '2.0',
      id: toolCalls()[0].id,
      result: { isError: true, content: [{ type: 'text', text: "You don't have read access to \"Data/Thing.md\"" }] },
    });
    await expect(renewed).resolves.toBeNull();
    expect(handoff()!.token).toBe('t');
  });

  it.each([
    ['carries no embed address', { note: 'This deployment is reached over plain http.' }],
    ['names another deployment', { embedUrl: 'https://elsewhere.example/embed?token=t2' }],
    ['carries no token', { embedUrl: `${ORIGIN}/embed` }],
  ])('gets no token when the answer %s', async (_label, structuredContent) => {
    handshake({ serverTools: {} });
    const page = await opened();
    const renewed = page.renew();
    fromHost({ jsonrpc: '2.0', id: toolCalls()[0].id, result: { structuredContent } });
    await expect(renewed).resolves.toBeNull();
    expect(handoff()!.token).toBe('t');
  });

  it('gives up when the host does not answer', async () => {
    vi.useFakeTimers();
    try {
      handshake({ serverTools: {} });
      fromHost(pageResult({ path: 'Data/Thing.md' }));
      await vi.advanceTimersByTimeAsync(0);
      const renewed = handoff()!.renew();
      expect(toolCalls()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(renewed).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('has nothing to ask for when the result echoed no path', async () => {
    handshake({ serverTools: {} });
    const page = await opened({});
    await expect(page.renew()).resolves.toBeNull();
    expect(toolCalls()).toHaveLength(0);
  });
});
