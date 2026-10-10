import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppRegistryContext, type AppRegistry } from '../../../core/registry';
import type { EmbedFileView } from '../services/embed.api';
import { EMBED_EXPIRED } from '../embed-host';
import { configureEmbed, resetEmbedConfig } from '../embed-config';
import { useRendererSurface } from '../../workspace/components/renderers/rendererSurface';

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
  resetEmbedConfig();
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

/**
 * The chat view's token lives minutes. When a call is refused for it (401),
 * the view asks its host for a fresh one — `open_page` again, through the
 * `renew` the MCP App view handed over — and runs the refused call once more
 * with it. The reader sees no expired sentence and loses nothing typed.
 */
describe('a chat view whose token runs out', () => {
  const EDITED = '# Thing\n\nWhat it is, edited.\n';
  const expired = () => new FakeEmbedApiError(401, 'Invalid or expired embed token');

  /** The chat view's handoff: a token, and a way to renew it. */
  function inChat(renew: () => Promise<string | null>) {
    const renewMock = vi.fn(renew);
    configureEmbed({ baseUrl: 'https://hexis.example', token: 'tok', renew: renewMock });
    return renewMock;
  }

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

  async function editing() {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByRole('button', { name: 'Save' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: EDITED } });
  }

  it('loads with a renewed token when the first load is refused for it', async () => {
    const renew = inChat(async () => 'tok-2');
    api.loadEmbed.mockImplementation(async (token: string) => {
      if (token === 'tok') throw expired();
      return view();
    });
    mount();
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(api.loadEmbed.mock.calls.map((c) => c[0])).toEqual(['tok', 'tok-2']);
    expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
  });

  it('takes the edit lock with a renewed token when Edit is refused for it', async () => {
    inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockRejectedValueOnce(expired()).mockResolvedValue({ acquired: true });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
    expect(api.lockEmbed.mock.calls.map((c) => c[0])).toEqual(['tok', 'tok-2']);
  });

  it('saves the draft on the retry when Save is refused for the token, and keeps the editor open meanwhile', async () => {
    const renew = inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    let release!: () => void;
    const renewed = new Promise<void>((resolve) => (release = resolve));
    renew.mockImplementation(async () => {
      await renewed;
      return 'tok-2';
    });
    api.saveEmbed.mockRejectedValueOnce(expired()).mockResolvedValue(undefined);
    mount();
    await editing();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // While the host renews, the editor is still the editor, on the draft.
    await waitFor(() => expect(renew).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(EDITED);
    expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
    release();

    await waitFor(() => expect(api.saveEmbed).toHaveBeenCalledTimes(2));
    expect(api.saveEmbed.mock.calls).toEqual([
      ['tok', EDITED],
      ['tok-2', EDITED],
    ]);
    expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends the proposal on the retry when it is refused for the token', async () => {
    inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(view({ canWrite: false }));
    api.proposeEmbed.mockRejectedValueOnce(expired()).mockResolvedValue({ url: '/change-requests/7' });
    mount();
    await userEvent.click(await screen.findByRole('button', { name: 'Propose changes' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: EDITED } });
    await userEvent.click(screen.getByRole('button', { name: 'Send proposal' }));
    expect(await screen.findByText(/sent for approval/i)).toBeTruthy();
    expect(api.proposeEmbed.mock.calls).toEqual([
      ['tok', EDITED],
      ['tok-2', EDITED],
    ]);
  });

  it('keeps the lock alive with a renewed token when a heartbeat is refused for it', async () => {
    const ticks = captureHeartbeats();
    inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.heartbeatEmbed.mockRejectedValueOnce(expired()).mockResolvedValue(undefined);
    mount();
    await editing();
    ticks.at(-1)!();
    await waitFor(() => expect(api.heartbeatEmbed).toHaveBeenCalledTimes(2));
    expect(api.heartbeatEmbed.mock.calls.map((c) => c[0])).toEqual(['tok', 'tok-2']);
    // The next one goes out with the fresh token, without asking again.
    ticks.at(-1)!();
    await waitFor(() => expect(api.heartbeatEmbed).toHaveBeenCalledTimes(3));
    expect(api.heartbeatEmbed.mock.calls[2][0]).toBe('tok-2');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(EDITED);
    expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
  });

  it('fetches bytes again with a renewed token, and hands later byte addresses the fresh one', async () => {
    inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(
      view({ repoRelative: 'Pages/Report.html', workspacePath: `${KB}/Pages/Report.html`, content: '<p>hi</p>' }),
    );
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('token=tok&') || url.endsWith('token=tok')
        ? new Response('', { status: 401 })
        : new Response('bytes', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    function Bytes() {
      const surface = useRendererSurface();
      const [body, setBody] = useState('');
      useEffect(() => {
        void surface?.rawFetch(`${KB}/Pages/Report.html`).then((res) => res.text()).then(setBody);
      }, [surface]);
      return (
        <div>
          <span data-testid="bytes">{body}</span>
          <span data-testid="src">{surface?.rawUrl(`${KB}/Pages/Report.html`)}</span>
        </div>
      );
    }
    const registry = {
      ...EMPTY_REGISTRY,
      renderers: [{ extensions: ['.html'], Component: Bytes }],
    } as unknown as AppRegistry;
    try {
      mount(registry);
      await waitFor(() => expect(screen.getByTestId('bytes').textContent).toBe('bytes'));
      expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(
        expect.arrayContaining(['/api/embed/raw?token=tok', '/api/embed/raw?token=tok-2']),
      );
      await waitFor(() => expect(screen.getByTestId('src').textContent).toBe('/api/embed/raw?token=tok-2'));
      expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * A picture the browser loads itself (`<img src>`) never reaches
   * `withEmbedToken`; one that fails is asked once more to learn why, and a
   * refusal for the token renews it and gives the picture the fresh address.
   */
  it('renews when a picture is refused for the token, and loads it again under the fresh one', async () => {
    const renew = inChat(async () => 'tok-2');
    api.embedRawUrl.mockImplementation(
      (token: string, path?: string) =>
        `https://hexis.example/api/embed/raw?token=${token}${path ? `&path=${path}` : ''}`,
    );
    api.loadEmbed.mockResolvedValue(view({ content: '# Thing\n\n![shot](shot.png)\n' }));
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      mount();
      const img = await screen.findByRole('img', { name: 'shot' });
      fireEvent.error(img);
      await waitFor(() =>
        expect(screen.getByRole('img', { name: 'shot' }).getAttribute('src')).toBe(
          'https://hexis.example/api/embed/raw?token=tok-2&path=/Data/shot.png',
        ),
      );
      expect(renew).toHaveBeenCalledTimes(1);
      // Refused again under the fresh token: left broken, never another renewal.
      fireEvent.error(screen.getByRole('img', { name: 'shot' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(EMBED_EXPIRED)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('asks for no renewal when a picture fails for a reason that is not the token', async () => {
    const renew = inChat(async () => 'tok-2');
    api.embedRawUrl.mockImplementation(
      (token: string, path?: string) =>
        `https://hexis.example/api/embed/raw?token=${token}${path ? `&path=${path}` : ''}`,
    );
    api.loadEmbed.mockResolvedValue(view({ content: '# Thing\n\n![shot](shot.png)\n' }));
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      mount();
      fireEvent.error(await screen.findByRole('img', { name: 'shot' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(renew).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  /**
   * No renewal to be had — the host does not run tools for a view, the call
   * failed, or `open_page` refused (read access withdrawn): the expired
   * sentence as before, with the draft kept on screen above it to copy.
   */
  it('shows the expired sentence with the draft kept above it when no renewal can be had', async () => {
    const renew = inChat(async () => null);
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.saveEmbed.mockRejectedValue(expired());
    mount();
    await editing();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(api.saveEmbed).toHaveBeenCalledTimes(1);
    const draft = screen.getByRole('textbox', { name: 'Your draft' }) as HTMLTextAreaElement;
    expect(draft.value).toBe(EDITED);
    expect(draft.readOnly).toBe(true);
    // Nothing can be sent from it any more, and the page itself is gone.
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Thing' })).toBeNull();
  });

  /**
   * Once the view has expired with an editor open, nothing keeps beating:
   * a heartbeat would be refused, ask the host for another token, and do so
   * again every beat — a renewal loop by another name.
   */
  it('stops the heartbeat once a refused heartbeat could not be renewed, so it never asks again', async () => {
    const ticks = captureHeartbeats();
    const clear = vi.spyOn(window, 'clearInterval');
    const renew = inChat(async () => null);
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.heartbeatEmbed.mockRejectedValue(expired());
    mount();
    await editing();
    const beats = ticks.length;
    ticks.at(-1)!();
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(renew).toHaveBeenCalledTimes(1);
    // The interval was taken down and no new one was set up.
    expect(clear).toHaveBeenCalled();
    expect(ticks).toHaveLength(beats);
    // Coming back to the tab does not take the lock again either.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(api.lockEmbed).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox', { name: 'Your draft' }) as HTMLTextAreaElement).value).toBe(EDITED);
  });

  it('shows the expired sentence when the renewal itself fails', async () => {
    inChat(async () => {
      throw new Error('the chat app did not answer');
    });
    api.loadEmbed.mockRejectedValue(expired());
    mount();
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /** At most one renewal per refused call: a second refusal ends it, never a loop. */
  it('renews once per refused call, and a second refusal in a row shows the expired sentence', async () => {
    const renew = inChat(async () => 'tok-2');
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.saveEmbed.mockRejectedValue(expired());
    mount();
    await editing();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(api.saveEmbed.mock.calls.map((c) => c[0])).toEqual(['tok', 'tok-2']);
    expect((screen.getByRole('textbox', { name: 'Your draft' }) as HTMLTextAreaElement).value).toBe(EDITED);
  });

  it('shares one renewal between calls refused together', async () => {
    let release!: (token: string) => void;
    const renew = inChat(() => new Promise<string>((resolve) => (release = resolve)));
    const ticks = captureHeartbeats();
    api.loadEmbed.mockResolvedValue(view());
    api.lockEmbed.mockResolvedValue({ acquired: true });
    api.heartbeatEmbed.mockRejectedValueOnce(expired()).mockResolvedValue(undefined);
    api.saveEmbed.mockRejectedValueOnce(expired()).mockResolvedValue(undefined);
    mount();
    await editing();
    ticks.at(-1)!();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.saveEmbed).toHaveBeenCalledTimes(1));
    release('tok-2');
    await waitFor(() => expect(api.saveEmbed).toHaveBeenCalledTimes(2));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(api.saveEmbed.mock.calls[1]).toEqual(['tok-2', EDITED]);
    expect(api.heartbeatEmbed.mock.calls.map((c) => c[0])).toEqual(['tok', 'tok-2']);
  });
});

/**
 * The SPA's `/embed` page, which an Atlassian panel frames, has no host to
 * ask: a refused token there is the expired sentence, as it always was.
 */
describe('the SPA embed page', () => {
  it('asks nobody for a token and shows the expired sentence when a call is refused for it', async () => {
    api.loadEmbed.mockRejectedValue(new FakeEmbedApiError(401, 'Invalid or expired embed token'));
    mount();
    expect(await screen.findByText(EMBED_EXPIRED)).toBeTruthy();
    expect(api.loadEmbed).toHaveBeenCalledTimes(1);
    expect(api.loadEmbed).toHaveBeenCalledWith('tok');
  });
});
