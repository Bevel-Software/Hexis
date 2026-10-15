// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeScript, type BridgeConfig } from '../views/bridge.js';
import { nativeMarkup } from '../views/native.js';

/**
 * The view as it runs in an MCP Apps host: the bridge (bridge.ts) and the
 * compact presentation (native.ts) executed in a DOM, talking to a fake host
 * over the same postMessage JSON-RPC a real host speaks. The host is the
 * view's `window.parent`; its answers arrive as `message` events from it.
 *
 * Every test mounts a view into the ONE window this file shares, so each
 * test takes down what its view put there: the listeners it added to the
 * window and the document, its timers (all fake, so `vi.waitFor` advances
 * them), its resize observers, and its host, which answers nothing after.
 * Otherwise a late message or timer from one test's view could change the
 * page another test is reading.
 */
let teardown: (() => void)[] = [];

/** Puts back a property as it was: its own descriptor if it had one, else the inherited one. */
function restoring(target: object, key: string): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  return () => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  teardown.push(restoring(window, 'parent'));
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener;
    const putBack = restoring(target, 'addEventListener');
    Object.defineProperty(target, 'addEventListener', {
      configurable: true,
      value(this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (fn) teardown.push(() => target.removeEventListener(type, fn, options));
        add.call(this, type, fn, options);
      },
    });
    teardown.push(putBack);
  }
  const Observer = globalThis.ResizeObserver;
  if (typeof Observer === 'function') {
    vi.stubGlobal(
      'ResizeObserver',
      class extends Observer {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          teardown.push(() => this.disconnect());
        }
      },
    );
  }
});

afterEach(() => {
  for (const undo of teardown.reverse()) undo();
  teardown = [];
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CONFIG: BridgeConfig = {
  view: 'show_to_do_list',
  dataTool: 'hexis_view_data',
  pagePath: 'KnowledgeBase/Juan/Dashboards/To-Do-List.html',
  branch: 'main',
  webBase: 'https://hexis.example',
  kbDir: 'knowledge-base',
};

const task = (name: string, due: string) => ({
  node_type: 'Task',
  file_path: `KnowledgeBase/Ops/Knowledge/Tasks/${name}.md`,
  fields: { Name: { text: name }, Status: { text: 'open' }, Due: { text: due } },
});
const SNAPSHOT = {
  format: 'hexis-kb-snapshot/1',
  takenAt: '2026-10-15',
  nodes: {
    'KnowledgeBase/Ops/Knowledge/Tasks/Bread.md': task('Bread', '2099-01-01'),
    'KnowledgeBase/Ops/Knowledge/Tasks/Milk.md': task('Milk', '2099-01-02'),
  },
  edges: [],
};

interface Msg {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
}
type Answer = (params: Record<string, unknown> | undefined) => unknown;

/** A host that answers the view's requests by method; a method with no answer is never answered. */
function fakeHost(answers: Record<string, Answer>) {
  const sent: Msg[] = [];
  let closed = false;
  teardown.push(() => (closed = true));
  const deliver = (data: unknown): void => {
    if (closed) return;
    window.dispatchEvent(new MessageEvent('message', { data, source: host as never }));
  };
  const host = {
    postMessage(msg: Msg) {
      sent.push(msg);
      const answer = msg.id !== undefined && msg.method ? answers[msg.method] : undefined;
      if (!answer) return;
      void Promise.resolve(answer(msg.params)).then((result) => deliver({ jsonrpc: '2.0', id: msg.id, result }));
    },
  };
  return {
    host,
    requests: (method: string) => sent.filter((m) => m.method === method && m.id !== undefined),
    /** Settles once the view has finished its handshake (it says so with `ui/notifications/initialized`). */
    initialized: () =>
      vi.waitFor(() => expect(sent.some((m) => m.method === 'ui/notifications/initialized')).toBe(true)),
    notify: (method: string, params: Record<string, unknown> = {}) => deliver({ jsonrpc: '2.0', method, params }),
  };
}

const scriptOf = (markup: string): string => markup.match(/<script[^>]*>([\s\S]*)<\/script>/)![1]!;

/** Open the view with `host` as its parent: the bridge first, then the compact presentation. */
function mount(host: object, body = ''): void {
  Object.defineProperty(window, 'parent', { value: host, configurable: true });
  document.documentElement.className = '';
  document.body.innerHTML = body;
  (window as unknown as { KB_SNAPSHOT: unknown }).KB_SNAPSHOT = SNAPSHOT;
  new Function(scriptOf(bridgeScript(CONFIG)))();
  new Function(scriptOf(nativeMarkup()))();
}

const initialize = (hostCapabilities: object, hostContext: object = {}) => () => ({
  protocolVersion: '2026-01-26',
  hostCapabilities,
  hostContext,
});

const compact = (): boolean => document.documentElement.classList.contains('hx-native');
const click = (selector: string): void => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`nothing at ${selector}`);
  el.click();
};
const bevel = (): { buildGraph(): Promise<{ nodes: Map<string, unknown> }> } =>
  (window as unknown as { bevel: { buildGraph(): Promise<{ nodes: Map<string, unknown> }> } }).bevel;

describe('links in a view', () => {
  it('opens a workspace URL in the web app as it is, and a relative link against the page', async () => {
    const h = fakeHost({ 'ui/initialize': initialize({ openLinks: {} }), 'ui/open-link': () => ({}) });
    mount(
      h.host,
      '<a id="abs" href="/workspace/main/knowledge-base/KnowledgeBase/Ops/Knowledge/Tasks/Bread.md">Bread</a>' +
        '<a id="rel" href="../Tasks/Milk.md#due">Milk</a>',
    );
    await h.initialized();
    click('#abs');
    click('#rel');
    await vi.waitFor(() => expect(h.requests('ui/open-link')).toHaveLength(2));
    expect(h.requests('ui/open-link').map((m) => m.params?.url)).toEqual([
      'https://hexis.example/workspace/main/knowledge-base/KnowledgeBase/Ops/Knowledge/Tasks/Bread.md',
      'https://hexis.example/workspace/main/knowledge-base/KnowledgeBase/Juan/Tasks/Milk.md#due',
    ]);
  });
});

describe('live data a view asks for itself', () => {
  /**
   * A view opened without a tool result (from a resource list, or a dropped
   * result) asks the server through the host. Hosts do not all advertise
   * `serverTools` even when they proxy calls, so the call is tried.
   */
  it('asks a host that does not advertise serverTools', async () => {
    const h = fakeHost({
      'ui/initialize': initialize({}),
      'tools/call': () => ({ content: [], _meta: { 'hexis/view': { snapshot: SNAPSHOT } } }),
    });
    mount(h.host);
    await h.initialized();
    h.notify('ui/notifications/tool-cancelled');
    const graph = await bevel().buildGraph();
    expect(h.requests('tools/call')[0]?.params).toEqual({
      name: 'hexis_view_data',
      arguments: { view: 'show_to_do_list', branch: 'main' },
    });
    expect(graph.nodes.size).toBe(2);
  });

  it('gives up on a host that neither advertises serverTools nor answers, instead of loading forever', async () => {
    const h = fakeHost({ 'ui/initialize': initialize({}) });
    mount(h.host);
    await vi.advanceTimersByTimeAsync(0);
    h.notify('ui/notifications/tool-cancelled');
    const graph = bevel().buildGraph();
    const settled = expect(graph).rejects.toThrow(/did not answer/);
    await vi.advanceTimersByTimeAsync(20_000);
    await settled;
    expect(h.requests('tools/call')).toHaveLength(1);
  });
});

describe('the compact presentation', () => {
  it('keeps the full page after "Full page" asks the host for fullscreen on a phone', async () => {
    const h: ReturnType<typeof fakeHost> = fakeHost({
      'ui/initialize': initialize({}, { platform: 'mobile', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] }),
      'ui/request-display-mode': (params) => {
        // A real host answers, then tells the view its new context too.
        setTimeout(() => h.notify('ui/notifications/host-context-changed', { displayMode: params?.mode }), 0);
        return { mode: params?.mode };
      },
    });
    mount(h.host);
    await h.initialized();
    expect(compact()).toBe(true);
    click('#hx-native [data-act="full"]');
    await vi.waitFor(() => expect(h.requests('ui/request-display-mode')).toHaveLength(1));
    // The host's own context message, sent right after its answer.
    await vi.advanceTimersByTimeAsync(20);
    expect(compact()).toBe(false);
  });

  it('keeps an edit made while the previous ones were being sent, for the next message', async () => {
    let answerMessage!: () => void;
    const h = fakeHost({
      'ui/initialize': initialize({}, { platform: 'mobile', displayMode: 'inline' }),
      'ui/message': () => new Promise<object>((resolve) => (answerMessage = () => resolve({}))),
    });
    mount(h.host);
    await h.initialized();
    expect(compact()).toBe(true);
    click('[data-act="toggle-done"][data-path$="Bread.md"]');
    expect(document.querySelector('.hx-pending-n')?.textContent).toBe('1 change');
    click('[data-act="send"]');
    await vi.waitFor(() => expect(h.requests('ui/message')).toHaveLength(1));
    expect(JSON.stringify(h.requests('ui/message')[0]?.params)).toContain('Bread.md');
    // Milk is ticked while the message about Bread is still out.
    click('[data-act="toggle-done"][data-path$="Milk.md"]');
    answerMessage();
    // The bridge says so once the host took the message; the view settles its queue right after.
    await vi.waitFor(() => expect(document.getElementById('hexis-bridge-toast')?.textContent).toMatch(/Sent to the chat/));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('.hx-pending-n')?.textContent).toBe('1 change');
    click('[data-act="send"]');
    await vi.waitFor(() => expect(h.requests('ui/message')).toHaveLength(2));
    const second = JSON.stringify(h.requests('ui/message')[1]?.params);
    expect(second).toContain('Milk.md');
    expect(second).not.toContain('Bread.md');
  });
});
