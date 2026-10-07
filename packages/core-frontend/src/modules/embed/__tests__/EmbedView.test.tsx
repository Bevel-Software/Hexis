import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppRegistryContext, type AppRegistry } from '../../../core/registry';
import type { EmbedFileView } from '../services/embed.api';
import { EMBED_EXPIRED } from '../embed-host';

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
  window.history.replaceState({}, '', '/embed?token=tok');
});

afterEach(() => {
  vi.restoreAllMocks();
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
  });
});
