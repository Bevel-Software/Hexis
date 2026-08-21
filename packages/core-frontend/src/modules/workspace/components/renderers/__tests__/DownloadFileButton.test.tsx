import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));
vi.mock('../../../state/workspace.context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));

import { CanDownloadContext, DownloadFileButton } from '../DownloadFileButton';

/**
 * The button reflects the per-path `download:` verb the backend resolves —
 * FileViewer provides the verdict through CanDownloadContext. The backend's
 * raw endpoint stays the authoritative gate; this is about not offering a
 * click that can only 403.
 */
describe('DownloadFileButton — download permission', () => {
  const renderWith = (canDownload: boolean | null) =>
    render(
      <CanDownloadContext.Provider value={canDownload}>
        <DownloadFileButton filePath="knowledge-base/Plugins/GTM/deck.pptx" />
      </CanDownloadContext.Provider>,
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
