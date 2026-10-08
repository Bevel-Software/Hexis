import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { AppRegistry } from '../../../core/registry';
import type { EmbedFileView } from '../services/embed.api';
import { resetEmbedConfig } from '../embed-config';

/** The HTTP surface, stubbed — the mount is about wiring, not about the API. */
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
    embedRawUrl: vi.fn((token: string, path?: string) => `/api/embed/raw?token=${token}${path ? `&path=${path}` : ''}`),
  };
});
vi.mock('../services/embed.api', () => api);

import { mountEmbed } from '../mount';

const ORIGIN = 'https://hexis.example';

const VIEW: EmbedFileView = {
  nodeName: 'Thing',
  repoRelative: 'Data/Thing.md',
  workspacePath: 'knowledge-base/Data/Thing.md',
  kbDirName: 'knowledge-base',
  branch: 'main',
  appUrl: `${ORIGIN}/workspace/main/knowledge-base/Data/Thing.md`,
  content: '# Thing\n\nWhat it is.\n',
  contentIsText: true,
  linked: true,
  canRead: true,
  canWrite: false,
  linkUrl: `${ORIGIN}/embed/link?token=tok`,
};

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

let el: HTMLElement;
let handle: { unmount(): void } | null = null;

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as { mockReset?: () => void }).mockReset?.();
  api.loadEmbed.mockResolvedValue(VIEW);
  el = document.createElement('div');
  document.body.appendChild(el);
});

afterEach(() => {
  handle?.unmount();
  handle = null;
  el.remove();
  resetEmbedConfig();
});

/**
 * What the MCP App view calls after loading the deployment's embed bundle
 * into a chat host's sandbox: the same embed the `/embed` route renders,
 * mounted outside the app, with the token handed in rather than read from a
 * page URL the sandbox does not have.
 */
describe('mountEmbed', () => {
  it('renders the page for the token it was handed, with the app renderer for the type', async () => {
    handle = mountEmbed(el, { registry: EMPTY_REGISTRY, origin: ORIGIN, token: 'tok' });
    expect(await screen.findByRole('heading', { name: 'Thing' })).toBeTruthy();
    expect(api.loadEmbed).toHaveBeenCalledWith('tok');
    // A reader who may not write is offered a proposal, as on the file page.
    expect(screen.getByRole('button', { name: 'Propose changes' })).toBeTruthy();
  });

  it('mounts a renderer the deployment registered, so the chat shows what the file page shows', async () => {
    const registry = {
      ...EMPTY_REGISTRY,
      renderers: [{ extensions: ['.md'], Component: () => <div data-testid="deployment-md">the deployment renderer</div> }],
    } as unknown as AppRegistry;
    handle = mountEmbed(el, { registry, origin: ORIGIN, token: 'tok' });
    expect(await screen.findByTestId('deployment-md')).toBeTruthy();
  });

  it('unmounts cleanly', async () => {
    handle = mountEmbed(el, { registry: EMPTY_REGISTRY, origin: ORIGIN, token: 'tok' });
    await screen.findByRole('heading', { name: 'Thing' });
    handle.unmount();
    handle = null;
    expect(el.textContent).toBe('');
  });
});
