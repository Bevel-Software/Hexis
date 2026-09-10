import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { ImageRenderer } from '../ImageRenderer';

beforeEach(() => {
  apiMock.authFetch.mockReset();
  (globalThis.URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
    () => 'blob:fake-url',
  );
  (globalThis.URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

/**
 * The whole-file image view (a `.png` opened from the tree) fetches through
 * `authFetch` and paints a blob URL. Pinned so the raw-route URL it asks for
 * cannot drift from the one the backend serves.
 */
describe('ImageRenderer', () => {
  it('fetches the bytes from the raw file route and paints them as a blob URL', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) });
    render(
      <WorkspaceContext.Provider
        value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
      >
        <ImageRenderer filePath="Knowledge/assets/shot.png" content="" onSave={async () => {}} />
      </WorkspaceContext.Provider>,
    );
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'blob:fake-url');
    expect(apiMock.authFetch).toHaveBeenCalledTimes(1);
    expect(apiMock.authFetch.mock.calls[0][0]).toBe(
      '/api/workspace/ws-1/file/raw?path=Knowledge%2Fassets%2Fshot.png',
    );
  });
});
