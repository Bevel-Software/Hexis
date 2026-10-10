import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppRegistryContext, type AppRegistry } from '../../../core/registry';
import type { EmbedFileView } from '../services/embed.api';
import { useEffect, useState } from 'react';
import { EMBED_EXPIRED, EMBED_HEIGHT_MESSAGE } from '../embed-host';
import { useKbGraphLoader } from '../../workspace/components/renderers/kbGraphLoader';

/**
 * The HTTP surface, stubbed. The error CLASS is hoisted with the rest: the
 * view tells an expired token from any other failure by `status`, so the
 * class the view does `instanceof` against has to be the one the stub
 * throws — and a `vi.mock` factory is hoisted above every declaration in the
 * file, so a class declared below it would not exist yet.
 */
const api = vi.hoisted(() => {
  class FakeEmbedApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'EmbedApiError';
      this.status = status;
    }
  }
  return {
    EmbedApiError: FakeEmbedApiError,
    loadEmbed: vi.fn(),
    lockEmbed: vi.fn(),
    heartbeatEmbed: vi.fn(),
    cancelEmbed: vi.fn(),
    saveEmbed: vi.fn(),
    proposeEmbed: vi.fn(),
    embedRawUrl: vi.fn(
      (token: string, path?: string) => `/api/embed/raw?token=${token}${path ? `&path=${path}` : ''}`,
    ),
  };
});
vi.mock('../services/embed.api', () => api);
const { EmbedApiError: FakeEmbedApiError } = api;

import { EmbedView } from '../components/EmbedView';

const KB = 'knowledge-base';
const PAGE = '# Thing\n\nWhat it is.\n';

function view(overrides: Partial<EmbedFileView> = {}): EmbedFileView {
  return {
    nodeName: 'Thing',
    repoRelative: 'Data/Thing.md',
    workspacePath: `${KB}/Data/Thing.md`,
    kbDirName: KB,
    branch: 'main',
    appUrl: 'https://hexis.example/workspace/main/knowledge-base/Data/Thing.md',
    content: PAGE,
    contentIsText: true,
    linked: true,
    canRead: true,
    canWrite: true,
    linkUrl: 'https://hexis.example/embed/link?token=tok',
    ...overrides,
  };
}

const EMPTY_REGISTRY = {
  apps: [],
  panes: [],
  topLevelRoutes: [],
  viewerRoutes: [],
  renderers: [],
  banners: [],
  fileViewerPanels: [],
  adminMenuItems: [],
  explorerItems: [],
  folderMenuItems: [],
  settingsNavItems: [],
} as unknown as AppRegistry;

function mount(registry: AppRegistry = EMPTY_REGISTRY) {
  return render(
    <AppRegistryContext.Provider value={registry}>
      <MemoryRouter>
        <EmbedView />
      </MemoryRouter>
    </AppRegistryContext.Provider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as { mockReset?: () => void }).mockReset?.();
  api.embedRawUrl.mockImplementation(
    (token: string, path?: string) => `/api/embed/raw?token=${token}${path ? `&path=${path}` : ''}`,
  );
  // The lock is let go on the way out too (unmount), so a test that ends
  // mid-edit sees a cancel it never arranged — answered, like the real call.
  api.cancelEmbed.mockResolvedValue(undefined);
  window.history.replaceState({}, '', '/embed?token=tok');
});

afterEach(() => {
  // Unmount BEFORE the mocks are restored: the view lets go of a held lock
  // on its way out, and that call must still meet the stubbed API.
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A host that sizes its frame to the content (the Atlassian issue panel)
 * follows the height the embed reports. Only when framed: with no host there
 * is nobody to tell.
 */
describe('reporting the content height to the host', () => {
  const realParent = Object.getOwnPropertyDescriptor(window, 'parent');
  // The connector's mint puts `sizing=content` on the address: this host
  // sizes its frame to the content.
  beforeEach(() => window.history.replaceState({}, '', '/embed?token=tok&sizing=content'));
  afterEach(() => {
    if (realParent) Object.defineProperty(window, 'parent', realParent);
  });

  it('keeps a fixed reading pane as it is: nothing relaxed, nothing posted, when the host did not ask for content sizing', async () => {
    window.history.replaceState({}, '', '/embed?token=tok');
    const host = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, value: host });
    api.loadEmbed.mockResolvedValue(view());
    mount();
    await screen.findByRole('heading', { name: 'Thing' });
    expect(host.postMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === EMBED_HEIGHT_MESSAGE)).toEqual([]);
    expect(document.documentElement.style.height).toBe('');
  });

  it('posts its height to the host when framed, and restores the page styles when it leaves', async () => {
    const host = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, value: host });
    api.loadEmbed.mockResolvedValue(view());
    const { unmount } = mount();
    await screen.findByRole('heading', { name: 'Thing' });
    const heights = () => host.postMessage.mock.calls.filter(([m]) => (m as { type?: string }).type === EMBED_HEIGHT_MESSAGE);
    // Once at mount, and again once the page is on screen — without relying
    // on a ResizeObserver, which jsdom (like some hosts) does not have.
    expect(heights().length).toBeGreaterThanOrEqual(2);
    expect(heights()[0]![0]).toEqual({ type: EMBED_HEIGHT_MESSAGE, height: expect.any(Number) });
    const beforeEdit = heights().length;
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(heights().length).toBeGreaterThan(beforeEdit));
    // The three-pane shell's 100% height is relaxed while the embed is up…
    expect(document.documentElement.style.height).toBe('auto');
    unmount();
    // …and put back when it is gone.
    expect(document.documentElement.style.height).toBe('');
  });

  it('posts the new height when the content grows without anything on screen changing', async () => {
    // The observer is what carries growth that changes no state — an image
    // loading, a renderer settling. jsdom has none, so a stand-in captures
    // the callback and the measured height is driven by hand.
    let onResize: (() => void) | null = null;
    class FakeResizeObserver {
      constructor(cb: () => void) {
        onResize = cb;
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    let measured = 240;
    vi.spyOn(document.documentElement, 'getBoundingClientRect').mockImplementation(
      () => ({ height: measured }) as DOMRect,
    );
    const host = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, value: host });
    api.loadEmbed.mockResolvedValue(view());
    try {
      mount();
      await screen.findByRole('heading', { name: 'Thing' });
      const last = () =>
        host.postMessage.mock.calls
          .map(([m]) => m as { type?: string; height?: number })
          .filter((m) => m.type === EMBED_HEIGHT_MESSAGE)
          .at(-1)?.height;
      expect(last()).toBe(240);
      expect(onResize).not.toBeNull();
      measured = 640;
      onResize!();
      expect(last()).toBe(640);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('posts nothing when it is not framed', async () => {
    const spy = vi.spyOn(window, 'postMessage');
    api.loadEmbed.mockResolvedValue(view());
    mount();
    await screen.findByRole('heading', { name: 'Thing' });
    expect(spy.mock.calls.filter(([m]) => (m as { type?: string })?.type === EMBED_HEIGHT_MESSAGE)).toEqual([]);
  });
});

describe('a view with no usable token', () => {
  /**
   * The one state that shows NO content, ever — and it must be reachable
   * without a request, because a view opened with no token at all has
   * nothing to ask.
   */
  it('says it expired, asks nothing, and shows no content when the token is absent', async () => {
    window.history.replaceState({}, '', '/embed');
    mount();
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(api.loadEmbed).not.toHaveBeenCalled();
    expect(screen.queryByText(/What it is/)).toBeNull();
  });

  it('says it expired when the token is rejected, and shows no content', async () => {
    api.loadEmbed.mockRejectedValue(new FakeEmbedApiError(401, 'Invalid or expired embed token'));
    mount();
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(screen.queryByText(/What it is/)).toBeNull();
    // Not the Edit control either: there is no page to edit.
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('does NOT claim expiry for a failure that is not about the token', async () => {
    api.loadEmbed.mockRejectedValue(new FakeEmbedApiError(500, 'Something went wrong.'));
    mount();
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Something went wrong.');
    expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
  });
});

describe('a writer', () => {
  it('sees Edit, and saving writes the page', async () => {
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.saveEmbed.mockResolvedValue(undefined);
    mount();

    const edit = await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByRole('button', { name: 'Propose changes' })).toBeNull();
    await userEvent.click(edit);

    await waitFor(() => expect(api.lockEmbed).toHaveBeenCalledWith('tok'));
    const save = await screen.findByRole('button', { name: 'Save' });
    await userEvent.click(save);
    await waitFor(() => expect(api.saveEmbed).toHaveBeenCalledWith('tok', PAGE));
    // A save goes to the default branch; it is never a proposal.
    expect(api.proposeEmbed).not.toHaveBeenCalled();
  });

  it('says who holds the lock rather than opening an editor', async () => {
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: false, holderName: 'Bob' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Bob is editing this page — try again shortly.',
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  /**
   * Hidden is not closed. The lock is let go while the frame is hidden — and
   * taken AGAIN when it comes back, before Save can mean anything. Somebody
   * who took it meanwhile keeps it, and Save is refused.
   */
  it('takes the lock again after a tab switch, and refuses Save if someone else took it', async () => {
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValueOnce({ acquired: true });
    api.cancelEmbed.mockResolvedValue(undefined);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('button', { name: 'Save' });

    const setVisibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('hidden');
    await waitFor(() => expect(api.cancelEmbed).toHaveBeenCalledWith('tok'));
    api.lockEmbed.mockResolvedValueOnce({ acquired: false, holderName: 'Bob' });
    setVisibility('visible');

    await waitFor(() => expect(api.lockEmbed).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Bob started editing this page/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.saveEmbed).not.toHaveBeenCalled();
  });

  it('keeps Save when the lock is taken back cleanly', async () => {
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.cancelEmbed.mockResolvedValue(undefined);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(api.lockEmbed).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  /**
   * Write access withdrawn mid-edit: the heartbeat answers 403. The editor
   * stays open with the draft, Save becomes Send proposal, and the reader is
   * told why — never an editor that quietly stopped saving.
   */
  /** Heartbeats captured instead of scheduled, so a test can fire one. */
  function captureHeartbeats(): Array<() => void> {
    const ticks: Array<() => void> = [];
    const realSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === 30_000) {
        ticks.push(fn);
        return 0;
      }
      return realSetInterval(fn, ms);
    }) as typeof window.setInterval);
    return ticks;
  }

  const EDITED = '# Thing\n\nWhat it is, edited.\n';

  async function editThenLoseWrite() {
    const ticks = captureHeartbeats();
    api.loadEmbed.mockResolvedValueOnce(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.cancelEmbed.mockResolvedValue(undefined);
    api.heartbeatEmbed.mockRejectedValue(new FakeEmbedApiError(403, 'Forbidden'));
    api.proposeEmbed.mockResolvedValue({ url: 'https://hexis.example/change-requests/3' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('button', { name: 'Save' });
    // The draft differs from the page, so a reload that dropped it would show.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: EDITED } });
    return ticks;
  }

  /**
   * Write access withdrawn mid-edit: the heartbeat answers 403. The editor
   * stays open with the draft, Save becomes Send proposal, and the reader is
   * told why — never an editor that quietly stopped saving.
   */
  it('turns Save into Send proposal, keeping the draft, when a heartbeat finds write access withdrawn', async () => {
    const ticks = await editThenLoseWrite();
    api.loadEmbed.mockResolvedValueOnce(view({ canWrite: false }));
    ticks.at(-1)!();

    expect(await screen.findByText(/You can no longer edit this page directly/)).toBeTruthy();
    // A proposal takes no lock, so the edit lock is released straight away.
    expect(api.cancelEmbed).toHaveBeenCalledWith('tok');
    const send = await screen.findByRole('button', { name: 'Send proposal' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(EDITED);
    await userEvent.click(send);
    await waitFor(() => expect(api.proposeEmbed).toHaveBeenCalledWith('tok', EDITED));
    expect(api.saveEmbed).not.toHaveBeenCalled();
  });

  /**
   * The same 403 when READ access went too. The no-access screen would strand
   * the draft, so the editor stays on it with nothing sendable, and says why;
   * Discard then lands on what the reader may now see.
   */
  it('keeps the draft on screen but sends nothing when a heartbeat finds read access withdrawn', async () => {
    const ticks = await editThenLoseWrite();
    api.loadEmbed.mockResolvedValue(view({ canRead: false, canWrite: false }));
    ticks.at(-1)!();

    expect(await screen.findByText(/You no longer have access to this page/)).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(EDITED);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    // The lock is let go at once, not left to block other writers until TTL.
    expect(api.cancelEmbed).toHaveBeenCalledWith('tok');
    api.cancelEmbed.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // And Discard releases again regardless — a no-op if it is already free.
    await waitFor(() => expect(api.cancelEmbed).toHaveBeenCalledWith('tok'));
    expect(await screen.findByText(/You don.t have access to this page/)).toBeTruthy();
    expect(screen.queryByText(/What it is/)).toBeNull();
    expect(api.saveEmbed).not.toHaveBeenCalled();
    expect(api.proposeEmbed).not.toHaveBeenCalled();
  });

  it('releases the lock on Discard', async () => {
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.cancelEmbed.mockResolvedValue(undefined);
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(api.cancelEmbed).toHaveBeenCalledWith('tok'));
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
  });
});

describe('a viewer without write access', () => {
  /**
   * NOT a "no access" notice where a control should be. The enterprise panel
   * this replaced told such a reader they had no edit access and left them a
   * link out; the rule now is that there is always something they can do.
   */
  it('sees Propose changes, and never a no-access notice', async () => {
    api.loadEmbed.mockResolvedValue(view({ canWrite: false }));
    mount();
    expect(await screen.findByRole('button', { name: 'Propose changes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText(/don't have edit access/i)).toBeNull();
    expect(screen.queryByText(/no access/i)).toBeNull();
  });

  it('sends the proposal, takes no lock, and points at the change request', async () => {
    api.loadEmbed.mockResolvedValue(view({ canWrite: false }));
    api.proposeEmbed.mockResolvedValue({ branch: 'suggestions/a-1/knowledge', number: 7, url: '/change-requests/7' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    // No round trip to open the editor: a proposal touches nothing on the
    // default branch, so there is no lock to take.
    expect(api.lockEmbed).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Send proposal' }));
    await waitFor(() => expect(api.proposeEmbed).toHaveBeenCalledWith('tok', PAGE));
    expect(await screen.findByText(/sent for approval/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the change request' })).toBeTruthy();
    // And nothing landed on the default branch.
    expect(api.saveEmbed).not.toHaveBeenCalled();
  });
});

describe('a viewer who cannot read the page, or is not linked', () => {
  it('is sent to sign in, with no content shown', async () => {
    api.loadEmbed.mockResolvedValue(view({ linked: false, canRead: false, content: '' }));
    mount();
    expect(await screen.findByRole('link', { name: 'Link your account' })).toBeTruthy();
    expect(screen.queryByText(/What it is/)).toBeNull();
  });

  it('is told to ask an owner, with no content shown', async () => {
    api.loadEmbed.mockResolvedValue(view({ canRead: false, canWrite: false, content: '' }));
    mount();
    expect(await screen.findByText(/don't have access to this page/i)).toBeTruthy();
    expect(screen.queryByText(/What it is/)).toBeNull();
  });
});

describe('a file with no editing surface', () => {
  /**
   * An image, a PDF, a workbook: the app's file page offers no write action
   * for these either, because there is no text behind the control. Nothing is
   * implied about access.
   */
  it.each([
    ['an image', 'Shots/x.png', false],
    ['a PDF', 'Docs/x.pdf', false],
    ['a Word document', 'Docs/x.docx', false],
  ])('offers no write action for %s', async (_label, repo, contentIsText) => {
    api.loadEmbed.mockResolvedValue(
      view({ repoRelative: repo, workspacePath: `${KB}/${repo}`, content: '', contentIsText }),
    );
    mount();
    await waitFor(() => expect(api.loadEmbed).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Thing')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Propose changes' })).toBeNull();
  });
});

describe('the renderer', () => {
  /**
   * The page is drawn by the APP's renderer for its type, through the same
   * lookup the file page uses — so a renderer a deployment REGISTERS reaches
   * the embed on the day it is added.
   */
  it('uses a deployment registered override when there is one', async () => {
    api.loadEmbed.mockResolvedValue(
      view({ repoRelative: 'Pages/Report.html', workspacePath: `${KB}/Pages/Report.html`, content: '<p>hi</p>' }),
    );
    const registry = {
      ...EMPTY_REGISTRY,
      renderers: [
        {
          extensions: ['.html', '.htm'],
          Component: () => <div data-testid="enterprise-html">the enterprise renderer</div>,
        },
      ],
    } as unknown as AppRegistry;
    mount(registry);
    expect(await screen.findByTestId('enterprise-html')).toBeTruthy();
  });

  /**
   * A renderer that draws the knowledge graph asks the SURFACE for it, and
   * the embed answers from the registry's graph source with its token —
   * the renderer never picks an address, so the same one draws inside an
   * issue panel as in the app. With no source registered the surface
   * offers nothing, and the renderer draws its fallback.
   */
  it('gives a registered renderer the knowledge graph through the surface, read with the embed token', async () => {
    api.loadEmbed.mockResolvedValue(
      view({ repoRelative: 'Pages/Dash.html', workspacePath: `${KB}/Pages/Dash.html`, content: '<p>dash</p>' }),
    );
    const inEmbed = vi.fn(async () => ({ nodes: { a: {} }, edges: [] }));
    const inApp = vi.fn(async () => ({ nodes: {}, edges: [] }));
    const GraphReader = () => {
      // As a dashboard renderer asks: never an address, only the loader.
      const load = useKbGraphLoader('ws-never-dialled');
      const [state, setState] = useState('no source');
      useEffect(() => {
        if (!load) return;
        void load().then((graph) => setState(`nodes:${Object.keys((graph as { nodes: object }).nodes).length}`));
      }, [load]);
      return <div data-testid="graph-reader">{state}</div>;
    };
    const renderers = [{ extensions: ['.html', '.htm'], Component: GraphReader }];
    mount({ ...EMPTY_REGISTRY, renderers, kbGraphSource: { inApp, inEmbed } } as unknown as AppRegistry);
    await waitFor(() => expect(screen.getByTestId('graph-reader').textContent).toBe('nodes:1'));
    expect(inEmbed).toHaveBeenCalledWith('tok');
    expect(inApp).not.toHaveBeenCalled();
    cleanup();

    mount({ ...EMPTY_REGISTRY, renderers } as unknown as AppRegistry);
    expect((await screen.findByTestId('graph-reader')).textContent).toBe('no source');
  });

  it('falls back to the built-in renderer for the type when nothing is registered', async () => {
    api.loadEmbed.mockResolvedValue(view());
    mount();
    // The markdown renderer's read view renders the heading as a heading.
    expect(await screen.findByRole('heading', { name: 'Thing' })).toBeTruthy();
  });

  /**
   * End to end for the link rule: the page the embed mounts must hand EVERY
   * outgoing link to the host, never leave one as an anchor the sandbox will
   * follow in place. An external link reaching the reader as
   * `target="_blank"` is the shape that navigated the frame away on a real
   * boot — `target` is ignored without `allow-popups`.
   */
  it('gives the app renderer the surface link policy, so no link navigates the frame', async () => {
    api.loadEmbed.mockResolvedValue(
      view({ content: '# Thing\n\n[docs](https://example.test/docs) and [other](Other.md)\n' }),
    );
    mount();
    const external = await screen.findByRole('link', { name: 'docs' });
    const internal = screen.getByRole('link', { name: 'other' });
    expect(external.getAttribute('target')).toBeNull();
    expect(internal.getAttribute('target')).toBeNull();

    // And a click on either is HANDED OVER: the frame's own navigation is
    // prevented, and the host path is what opens it (standalone, as here,
    // that path is a new tab).
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    expect(fireEvent.click(external)).toBe(false);
    expect(fireEvent.click(internal)).toBe(false);
    expect(open.mock.calls.map((c) => c[0])).toEqual([
      'https://example.test/docs',
      `${window.location.origin}/workspace/main/${KB}/Data/Other.md`,
    ]);
    expect(open.mock.calls.every((c) => c[1] === '_blank')).toBe(true);
  });

  /**
   * A picture in a markdown page is fetched under the token from the
   * repository root — the renderer hands the surface a WORKSPACE path, and
   * sent as written the server resolved it beside the page a second time
   * (`Data/knowledge-base/Data/shot.png`), so every image 404'd.
   */
  it('asks for a picture beside the page by its repository path', async () => {
    api.loadEmbed.mockResolvedValue(view({ content: '# Thing\n\n![shot](shot.png)\n' }));
    mount();
    const img = await screen.findByRole('img', { name: 'shot' });
    expect(img.getAttribute('src')).toBe('/api/embed/raw?token=tok&path=/Data/shot.png');
    expect(api.embedRawUrl).toHaveBeenCalledWith('tok', '/Data/shot.png', expect.anything());
  });

  /**
   * A heading's copy-link is the page's canonical address plus the heading.
   * A view opened AT a heading carries that heading in its app address; the
   * canonical address drops it, or every copied link would carry two.
   */
  it('copies a heading link from the page address without the heading the view opened at', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    // A stub `vi.restoreAllMocks` does not know about: removed by hand, so
    // no later test in this file meets a clipboard this one left behind.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      api.loadEmbed.mockResolvedValue(
        view({
          appUrl: 'https://hexis.example/workspace/main/knowledge-base/Data/Thing.md#what-it-is',
          heading: 'what-it-is',
        }),
      );
      mount();
      const btn = await screen.findByRole('button', { name: /copy link to this heading/i });
      fireEvent.click(btn);
      expect(writeText).toHaveBeenCalledWith('https://hexis.example/workspace/main/knowledge-base/Data/Thing.md#thing');
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
