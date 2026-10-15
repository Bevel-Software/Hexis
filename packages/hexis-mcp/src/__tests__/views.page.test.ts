// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTML_NAV_BRIDGE } from '@bevel-software/platform-shared';
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
  linkTool: 'hexis_view_link',
  pagePath: 'KnowledgeBase/Juan/Dashboards/To-Do-List.html',
  branch: 'main',
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

/** An answer that refuses the request, as a host's JSON-RPC error does. */
class Refusal {
  constructor(readonly message: string) {}
}

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
      void Promise.resolve(answer(msg.params)).then((result) =>
        deliver(
          result instanceof Refusal
            ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: result.message } }
            : { jsonrpc: '2.0', id: msg.id, result },
        ),
      );
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
function mount(host: object, body = '', snapshot: object = SNAPSHOT): void {
  Object.defineProperty(window, 'parent', { value: host, configurable: true });
  document.documentElement.className = '';
  document.body.innerHTML = body;
  (window as unknown as { KB_SNAPSHOT: unknown }).KB_SNAPSHOT = snapshot;
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
  /**
   * A host whose server answers the link tool with an address of its own, so
   * each test sees the bridge open exactly what the server said. What the
   * server answers for each kind of link is pinned in views.test.ts (the
   * link tool) and end to end in views.host.test.ts.
   */
  const linkHost = (answer?: Answer) =>
    fakeHost({
      'ui/initialize': initialize({ openLinks: {}, serverTools: {} }),
      'tools/call': (params) =>
        params?.name === 'hexis_view_link'
          ? (answer?.(params) ??
            { content: [], structuredContent: { url: `https://hexis.example/opened?${String((params.arguments as { href: string }).href)}` } })
          : undefined,
      'ui/open-link': () => ({}),
    });
  const linkCalls = (h: ReturnType<typeof fakeHost>) =>
    h.requests('tools/call').filter((m) => m.params?.name === 'hexis_view_link').map((m) => (m.params?.arguments as { href: string }).href);

  it("runs the app's own navigation runtime, verbatim", () => {
    expect(bridgeScript(CONFIG)).toContain(HTML_NAV_BRIDGE);
  });

  it('opens an anchor where the server says the link goes, sending the link as the page wrote it', async () => {
    const h = linkHost();
    mount(h.host, '<a id="rel" href="../Tasks/Milk.md#due">Milk</a>');
    await h.initialized();
    click('#rel');
    await vi.waitFor(() => expect(h.requests('ui/open-link')).toHaveLength(1));
    expect(h.requests('tools/call')[0]?.params).toEqual({
      name: 'hexis_view_link',
      arguments: { view: 'show_to_do_list', href: '../Tasks/Milk.md#due', branch: 'main' },
    });
    expect(h.requests('ui/open-link')[0]?.params?.url).toBe('https://hexis.example/opened?../Tasks/Milk.md#due');
  });

  it('gives scripts window.bevel.openNode and navigate, which open a link the same way', async () => {
    const h = linkHost();
    mount(h.host);
    await h.initialized();
    const api = window as unknown as { bevel: { openNode(href: string): void; navigate(href: string): void } };
    api.bevel.openNode('/workspace/main/knowledge-base/KnowledgeBase/Ops/A.md');
    api.bevel.navigate('https://example.com/x');
    await vi.waitFor(() => expect(h.requests('ui/open-link')).toHaveLength(2));
    expect(linkCalls(h)).toEqual(['/workspace/main/knowledge-base/KnowledgeBase/Ops/A.md', 'https://example.com/x']);
  });

  it('scrolls a fragment inside the frame and asks the server nothing', async () => {
    const h = linkHost();
    mount(h.host, '<a id="jump" href="#due">Due</a><h2 id="due">Due</h2>');
    await h.initialized();
    const scrolled = vi.fn();
    document.getElementById('due')!.scrollIntoView = scrolled;
    click('#jump');
    await vi.advanceTimersByTimeAsync(10);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(linkCalls(h)).toEqual([]);
  });

  it('leaves a click the page already handled to the page', async () => {
    const h = linkHost();
    mount(h.host, '<a id="own" href="../Tasks/Milk.md">Milk</a>');
    await h.initialized();
    document.getElementById('own')!.addEventListener('click', (e) => e.preventDefault());
    click('#own');
    await vi.advanceTimersByTimeAsync(10);
    expect(linkCalls(h)).toEqual([]);
    expect(h.requests('ui/open-link')).toHaveLength(0);
  });

  it('opens nothing the server refuses, and says so', async () => {
    const h = linkHost(() => ({ isError: true, content: [{ type: 'text', text: 'This link cannot be opened: javascript:alert(1)' }] }));
    mount(h.host, '<a id="bad" href="javascript:alert(1)">Run</a>');
    await h.initialized();
    click('#bad');
    await vi.waitFor(() =>
      expect(document.getElementById('hexis-bridge-toast')?.textContent).toBe('This link cannot be opened: javascript:alert(1)'),
    );
    expect(h.requests('ui/open-link')).toHaveLength(0);
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

const lead = (name: string, stage: string, company: string) => ({
  node_type: 'Lead',
  file_path: `KnowledgeBase/Sales/Leads/${name}.md`,
  fields: { Name: { text: name }, Stage: { text: stage }, Company: { text: company } },
});
/** One board: leads by Stage, Won counts as done, cards show their Company. */
const BOARD_SNAPSHOT = {
  format: 'hexis-kb-snapshot/1',
  takenAt: '2026-10-15',
  nodes: {
    'KnowledgeBase/Sales/Boards/Leads.md': {
      node_type: 'Board',
      file_path: 'KnowledgeBase/Sales/Boards/Leads.md',
      fields: {
        Name: { text: 'Leads' },
        'Card Type': { text: 'Lead' },
        Folder: { text: 'KnowledgeBase/Sales/Leads' },
        'Column Field': { text: 'Stage' },
        Columns: { text: '- New\n- Contacted\n- Won' },
        'Done Columns': { text: '- Won' },
        'Card Fields': { text: '- Company' },
      },
    },
    'KnowledgeBase/Sales/Leads/Acme.md': lead('Acme', 'New', 'Acme Corp'),
    'KnowledgeBase/Sales/Leads/Globex.md': lead('Globex', 'Contacted', 'Globex Inc'),
    'KnowledgeBase/Sales/Leads/Initech.md': lead('Initech', 'Won', 'Initech LLC'),
  },
  edges: [],
};
const texts = (selector: string): string[] =>
  [...document.querySelectorAll(selector)].map((el) => (el.textContent ?? '').trim());

describe('the compact board', () => {
  const phone = { platform: 'mobile', displayMode: 'inline' };

  it('shows a board as its columns, each with its count, opening on the first open column', async () => {
    const h = fakeHost({ 'ui/initialize': initialize({}, phone) });
    mount(h.host, '', BOARD_SNAPSHOT);
    await h.initialized();
    expect(texts('#hx-native .hx-title')).toEqual(['Leads']);
    expect(texts('#hx-native .hx-sub')).toEqual(['2 open · 1 done']);
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-act="tab"]')].map((t) => [
      t.dataset.col,
      t.querySelector('.hx-tab-n')?.textContent,
      t.getAttribute('aria-selected'),
    ]);
    expect(tabs).toEqual([
      ['New', '1', 'true'],
      ['Contacted', '1', 'false'],
      ['Won', '1', 'false'],
    ]);
    expect(texts('.hx-card .hx-row-title')).toEqual(['Acme']);
    expect(texts('.hx-card .hx-row-sub')).toEqual(['Acme Corp']);
    click('[data-act="tab"][data-col="Contacted"]');
    expect(texts('.hx-card .hx-row-title')).toEqual(['Globex']);
  });

  it('moves a card to another column, and sends the move to the chat', async () => {
    const h = fakeHost({ 'ui/initialize': initialize({}, phone), 'ui/message': () => ({}) });
    mount(h.host, '', BOARD_SNAPSHOT);
    await h.initialized();
    click('[data-act="open-item"][data-path$="Acme.md"]');
    click('[data-act="set-col"][data-col="Contacted"]');
    expect(document.querySelector('.hx-pending-n')?.textContent).toBe('1 change');
    click('[data-act="send"]');
    await vi.waitFor(() => expect(h.requests('ui/message')).toHaveLength(1));
    expect(JSON.stringify(h.requests('ui/message')[0]?.params)).toContain(
      'In KnowledgeBase/Sales/Leads/Acme.md (\\"Acme\\"), set Stage to Contacted.',
    );
  });
});

describe('compact or the full page', () => {
  /** The frame's width, as the host sized it. */
  const sized = (width: number): void => {
    teardown.push(restoring(window, 'innerWidth'));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  };

  it.each([
    ['a phone', { platform: 'mobile', displayMode: 'fullscreen' }, 1024, true],
    ['a narrow frame', { platform: 'desktop', displayMode: 'fullscreen' }, 600, true],
    ['an inline frame', { platform: 'desktop', displayMode: 'inline' }, 1024, true],
    ['a wide fullscreen frame on a desktop', { platform: 'desktop', displayMode: 'fullscreen' }, 1024, false],
  ] as const)('on %s, compact: %s', async (_where, context, width, expected) => {
    sized(width);
    const h = fakeHost({ 'ui/initialize': initialize({}, { ...context, availableDisplayModes: ['inline', 'fullscreen'] }) });
    mount(h.host);
    await h.initialized();
    expect(compact()).toBe(expected);
  });

  it('switches the full page to the compact presentation when asked', async () => {
    sized(1024);
    const h = fakeHost({
      'ui/initialize': initialize({}, { platform: 'desktop', displayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] }),
      'ui/request-display-mode': (params) => ({ mode: params?.mode }),
    });
    mount(h.host);
    await h.initialized();
    expect(compact()).toBe(false);
    click('#hx-page-controls [data-act="compact"]');
    await vi.waitFor(() => expect(h.requests('ui/request-display-mode')).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(compact()).toBe(true);
  });
});

describe('"copy changes" in the page', () => {
  /** The browser's clipboard, as the page found it: what it copied. */
  const clipboard = () => {
    const copied = vi.fn<(text: string) => Promise<void>>(async () => {});
    teardown.push(restoring(navigator, 'clipboard'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copied } });
    return copied;
  };
  const write = (text: string): Promise<void> =>
    (navigator as unknown as { clipboard: { writeText(text: string): Promise<void> } }).clipboard.writeText(text);

  it('sends what the page copies to the chat, and still copies it', async () => {
    const copied = clipboard();
    const h = fakeHost({ 'ui/initialize': initialize({}), 'ui/message': () => ({}) });
    mount(h.host);
    await h.initialized();
    await write('Set Bread to done');
    expect(h.requests('ui/message')[0]?.params).toEqual({ role: 'user', content: [{ type: 'text', text: 'Set Bread to done' }] });
    expect(copied).toHaveBeenCalledWith('Set Bread to done');
  });

  it('only copies when the host refuses the message', async () => {
    const copied = clipboard();
    const h = fakeHost({ 'ui/initialize': initialize({}), 'ui/message': () => new Refusal('not here') });
    mount(h.host);
    await h.initialized();
    await write('Set Bread to done');
    expect(h.requests('ui/message')).toHaveLength(1);
    expect(copied).toHaveBeenCalledWith('Set Bread to done');
  });

  it('only copies before the view has spoken to its host', async () => {
    const copied = clipboard();
    const h = fakeHost({});
    mount(h.host);
    await write('Set Bread to done');
    expect(h.requests('ui/message')).toHaveLength(0);
    expect(copied).toHaveBeenCalledWith('Set Bread to done');
  });
});
