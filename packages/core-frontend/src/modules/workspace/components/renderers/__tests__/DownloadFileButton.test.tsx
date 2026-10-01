import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';
import { CanDownloadContext, DownloadFileButton } from '../DownloadFileButton';

/**
 * The button reads its workspace through `useRendererWorkspaceId`, so the
 * checked-out workspace is PROVIDED here rather than the hook mocked away —
 * the change-request dialog overrides that same lookup to point the viewers
 * at a request's branch, and a mocked hook would hide whether it still works.
 */
function withWorkspace(node: ReactNode) {
  return (
    <WorkspaceContext.Provider
      value={
        { workspaceId: 'ws-1', kbDirName: 'knowledge-base' } as unknown as WorkspaceContextValue
      }
    >
      {node}
    </WorkspaceContext.Provider>
  );
}

/**
 * The button reflects the per-path `download:` verb the backend resolves —
 * FileViewer provides the verdict through CanDownloadContext. The backend's
 * raw endpoint stays the authoritative gate; this is about not offering a
 * click that can only 403.
 */
describe('DownloadFileButton — download permission', () => {
  const renderWith = (canDownload: boolean | null) =>
    render(
      withWorkspace(
        <CanDownloadContext.Provider value={canDownload}>
          <DownloadFileButton filePath="knowledge-base/Plugins/GTM/deck.pptx" />
        </CanDownloadContext.Provider>,
      ),
    );

  it('is disabled with an explanation when the download verb says no', () => {
    renderWith(false);
    const button = screen.getByRole('button', { name: 'Download' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'You do not have download permission for this file.',
    );
  });

  it('stays clickable on an explicit yes', () => {
    renderWith(true);
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  it('stays optimistic while the verdict is unknown — the backend still gates', () => {
    // null = lookup in flight (or rendered outside FileViewer). Mirrors the
    // editor: no flicker into disabled while the answer loads.
    renderWith(null);
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });
});

/** The URL the button fetches is the raw file route's download form, built by `rawFileUrl`. */
describe('DownloadFileButton — the URL it fetches', () => {
  it('asks the raw file route for this file as a download', async () => {
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(['bytes']),
      text: async () => '',
    });
    (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
      () => 'blob:fake-url',
    );
    (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    render(
      withWorkspace(
        <CanDownloadContext.Provider value={true}>
          <DownloadFileButton filePath="knowledge-base/Plugins/GTM/deck.pptx" />
        </CanDownloadContext.Provider>,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(apiMock.authFetch).toHaveBeenCalled());
    expect(apiMock.authFetch.mock.calls[0][0]).toBe(
      '/api/workspace/ws-1/file/raw?path=knowledge-base%2FPlugins%2FGTM%2Fdeck.pptx&download=1',
    );
  });
});
